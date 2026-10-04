import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, sql } from "drizzle-orm";

import { getDatabase, type Executor } from "../db/client.js";
import { attachments } from "../db/schema/index.js";
import { auditActions, writeAudit } from "./audit.js";
import { attachmentDirectory, safeAttachmentPath } from "./backup.js";
import { notFound, payloadTooLarge, unsupportedMedia } from "./errors.js";
import type { Actor } from "./types.js";

/**
 * Payment-proof and other attachment storage (§3.6, §4.4).
 *
 * The specification asks for three separate controls, and each is a real check
 * here rather than a comment:
 *
 *  1. **Type** - a proof is a screenshot or a PDF. The declared MIME type is
 *     checked against an allow-list and then *confirmed against the file's own
 *     magic bytes*. The stored name's extension is taken from the sniffed type,
 *     never from the client, so a renamed executable is rejected outright and
 *     `proof.exe` can never be served back as if it were an image.
 *  2. **Size** - capped at 5 MB. A proof of payment is a phone screenshot, so
 *     anything larger is a mistake or an attempt to fill the disk. The cap is
 *     enforced by a counting transform in the write pipeline, so it holds even
 *     if the multipart parser's own limit is bypassed.
 *  3. **Safe storage path** - the client filename is never used as a path. The
 *     stored name is a timestamp plus a sanitised basename inside a sharded
 *     folder, and every read goes back through `safeAttachmentPath`, which
 *     refuses to resolve outside the attachment root. A crafted
 *     `../../app/.env` therefore cannot be stored and later served.
 *
 * Bytes land in a `.partial` scratch file first and are only renamed into place
 * after the type check passes. Two things fall out of that: the final name can be
 * derived from the *verified* content type, and no half-written file is ever
 * reachable by the GCash verification screen or a backup. The rename is atomic
 * within one volume, so the register can never point at a missing file.
 *
 * The SHA-256 is computed as the bytes stream past, making it a fact about the
 * stored content rather than a second read of the same file.
 */

/** §3.7's evidence is a screenshot; PDF is included because staff also forward PDFs. */
const ALLOWED_TYPES = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["application/pdf", ".pdf"]
]);

/** 5 MB. A phone screenshot is well under 1 MB, so this is generous, not tight. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Scratch folder for in-flight uploads. Never referenced by a stored path. */
const PARTIAL_DIR = ".partial";

/**
 * Content signatures used to confirm the declared MIME type.
 *
 * The bytes win over the client's `Content-Type` header, because that header is
 * just a string the client chose.
 */
const SIGNATURES: Array<{ mime: string; test: (head: Buffer) => boolean }> = [
  { mime: "image/jpeg", test: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  {
    mime: "image/png",
    test: (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  },
  { mime: "image/gif", test: (head) => head.subarray(0, 6).toString("latin1").startsWith("GIF8") },
  { mime: "application/pdf", test: (head) => head.subarray(0, 5).toString("latin1") === "%PDF-" },
  {
    mime: "image/webp",
    test: (head) =>
      head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP"
  }
];

export interface AttachmentInput {
  originalName: string;
  declaredMimeType: string;
  stream: Readable;
  /** Entity the file belongs to, e.g. `GCASH_PROOF`. */
  entityType: string;
  entityId: string;
}

export interface AttachmentRecord {
  id: string;
  entityType: string;
  entityId: string;
  originalName: string;
  storedPath: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  uploadedBy: string | null;
  uploadedByName: string | null;
  uploadedAt: Date;
}

/** Reads the leading bytes needed for content sniffing. */
async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function detectMime(head: Buffer): string | undefined {
  return SIGNATURES.find((signature) => signature.test(head))?.mime;
}

/**
 * A pass-through that counts bytes, hashes them, and aborts the pipeline the
 * moment the cap is passed.
 *
 * Failing inside the transform is what makes the limit real: the error propagates
 * through `pipeline`, which destroys the write stream, so the partial file is
 * closed and the cleanup in the caller can safely remove it.
 */
function meter(hash: ReturnType<typeof createHash>, onSize: (size: number) => void): Transform {
  let size = 0;
  const cap = MAX_ATTACHMENT_BYTES;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > cap) {
        callback(
          payloadTooLarge(`Attachments are limited to ${Math.floor(cap / 1024 / 1024)} MB.`, {
            limitBytes: cap
          })
        );
        return;
      }
      hash.update(chunk);
      onSize(size);
      callback(null, chunk);
    }
  });
}

/**
 * Single path segment, so a stored name can never traverse.
 *
 * The client's extension is stripped because the stored extension is taken from
 * the sniffed type; keeping it would produce `proof.png.png`.
 */
function sanitizedBase(originalName: string): string {
  const base = basename(originalName).replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "attachment";
  return base.replace(/\.[A-Za-z0-9]{1,8}$/, "") || "attachment";
}

/**
 * Stores one file and records it in the `attachments` register.
 *
 * On any failure the scratch file is removed and no row is written, so a
 * rejected upload leaves no trace in the register and nothing on disk for a
 * backup to pick up.
 */
export async function storeAttachment(input: AttachmentInput, actor?: Actor): Promise<AttachmentRecord> {
  const declared = input.declaredMimeType?.split(";")[0]?.trim().toLowerCase() ?? "";

  // Reject an unsupported declared type before a single byte is read, so a
  // request for something the system will never accept costs nothing.
  if (!ALLOWED_TYPES.has(declared)) {
    throw unsupportedMedia(
      `Attachments must be a JPEG, PNG, WebP, GIF image or a PDF. Received ${declared || "an unknown type"}.`,
      { received: declared, allowed: [...ALLOWED_TYPES.keys()] }
    );
  }

  const scratchDir = join(attachmentDirectory(), PARTIAL_DIR);
  await mkdir(scratchDir, { recursive: true });

  const id = randomUUID();
  const scratchPath = join(scratchDir, `${id}.part`);

  let finalAbsolute: string | undefined;

  try {
    const hash = createHash("sha256");
    let sizeBytes = 0;

    await pipeline(
      input.stream,
      meter(hash, (size) => {
        sizeBytes = size;
      }),
      createWriteStream(scratchPath)
    );

    if (sizeBytes === 0) {
      throw unsupportedMedia("The uploaded file is empty.");
    }

    // Confirm the bytes, then take the extension from the result. Trusting the
    // client's name here is what this whole check exists to prevent.
    const head = await readHead(scratchPath, 16);
    const detected = detectMime(head);

    if (!detected) {
      throw unsupportedMedia(
        "The uploaded file is not a recognised image or PDF. Its contents do not match its file type."
      );
    }

    if (detected !== declared) {
      throw unsupportedMedia(
        `The file's contents look like ${detected} but it was uploaded as ${declared || "an unknown type"}. Re-upload the correct file.`,
        { declared, detected }
      );
    }

    const extension = ALLOWED_TYPES.get(detected) ?? ".bin";
    // Stored with a POSIX separator so the row stays valid if the database is
    // restored onto a different operating system; `safeAttachmentPath`
    // normalises it back to the host separator on every read and write.
    const relativePath = `${id.slice(0, 2)}/${Date.now()}-${sanitizedBase(input.originalName)}${extension}`;
    finalAbsolute = safeAttachmentPath(relativePath);

    await mkdir(join(attachmentDirectory(), id.slice(0, 2)), { recursive: true });
    await rename(scratchPath, finalAbsolute);

    const checksumSha256 = hash.digest("hex");

    const { db } = getDatabase();
    const [row] = await db
      .insert(attachments)
      .values({
        id,
        entityType: input.entityType,
        entityId: input.entityId,
        originalName: sanitizedBase(input.originalName),
        storedPath: relativePath,
        mimeType: detected,
        sizeBytes,
        checksumSha256,
        uploadedBy: actor?.id ?? null,
        uploadedByName: actor?.displayName ?? null
      })
      .returning();

    await writeAudit(db, actor, {
      action: auditActions.ATTACHMENT_UPLOADED,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: { attachmentId: id, originalName: input.originalName.slice(0, 200), mimeType: detected, sizeBytes, checksumSha256 }
    });

    return row as AttachmentRecord;
  } catch (error) {
    await rm(scratchPath, { force: true });
    // Covers the window where the rename succeeded but the insert failed.
    if (finalAbsolute) {
      await rm(finalAbsolute, { force: true });
    }
    throw error;
  }
}

/** Loads the register row. */
export async function getAttachment(attachmentId: string): Promise<AttachmentRecord> {
  const { db } = getDatabase();
  const [row] = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).limit(1);
  if (!row) {
    throw notFound("Attachment", attachmentId);
  }
  return row as AttachmentRecord;
}

export interface OpenedAttachment {
  record: AttachmentRecord;
  absolutePath: string;
  /** A readable stream positioned at the start of the file. */
  stream: Readable;
  sizeBytes: number;
}

/**
 * Prepares an attachment for streaming back to the client.
 *
 * The GCash verification screen needs a proof preview (§4.3), which means serving
 * customer-supplied bytes to a browser. The path is re-validated here rather than
 * trusted from the database, so a row tampered with directly in PostgreSQL still
 * cannot make the API read something outside the attachment root.
 */
export async function openAttachment(attachmentId: string): Promise<OpenedAttachment> {
  const record = await getAttachment(attachmentId);
  const absolutePath = safeAttachmentPath(record.storedPath);

  if (!existsSync(absolutePath)) {
    throw notFound("Attachment file", attachmentId);
  }

  const fileStat = await stat(absolutePath);
  return { record, absolutePath, stream: createReadStream(absolutePath), sizeBytes: fileStat.size };
}

export async function listAttachments(entityType: string, entityId: string): Promise<AttachmentRecord[]> {
  const { db } = getDatabase();
  return db
    .select()
    .from(attachments)
    .where(and(eq(attachments.entityType, entityType), eq(attachments.entityId, entityId)))
    .orderBy(desc(attachments.uploadedAt));
}

/** The most recent attachments across all entities, for the Administration screen. */
export async function listRecentAttachments(limit = 50): Promise<AttachmentRecord[]> {
  const { db } = getDatabase();
  return db.select().from(attachments).orderBy(desc(attachments.uploadedAt)).limit(limit);
}

/** File count and total bytes, shown on the Administration screen. */
export async function attachmentStats(executor: Executor): Promise<{ files: number; bytes: number }> {
  const result = await executor.execute(sql`
    select count(*)::int as files, coalesce(sum(size_bytes), 0)::bigint as bytes
    from attachments
  `);
  const row = result.rows[0] as { files: number; bytes: number } | undefined;
  return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
}
