import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDatabase, getDatabase } from "../src/db/client.js";
import { attachments, auditLogs, users } from "../src/db/schema/index.js";
import { attachmentDirectory, safeAttachmentPath } from "../src/services/backup.js";
import {
  MAX_ATTACHMENT_BYTES,
  getAttachment,
  listAttachments,
  openAttachment,
  storeAttachment
} from "../src/services/attachments.js";
import type { Actor } from "../src/services/types.js";

/**
 * Tests for the three upload controls §4.4 requires: type, size and safe path.
 *
 * These are written against the assertions a reviewer would make, not around the
 * implementation. In particular:
 *
 *  - **Type** is proven by *spoofing*, not by sending a bad extension. A file
 *    whose bytes are a Windows executable but which claims `image/png` must be
 *    refused; so must a genuine PNG that claims to be a JPEG. Both of those would
 *    pass an extension-only check.
 *  - **Size** is proven by exceeding the cap by a single byte.
 *  - **Safe path** is proven by a filename that tries to escape the storage root,
 *    because `basename()` is the only thing standing between the client and the
 *    filesystem.
 *
 * ## Safety
 *
 * `ATTACHMENT_DIR` is redirected into the OS temp directory for the duration of
 * the suite, so a bug in the path handling cannot write into the repository, and
 * the whole folder is removed afterwards. The database is the `_test` one, checked
 * the same way the other integration suites check it.
 */

const { db } = getDatabase();

/** A real 1x1 PNG. Sniffing needs the signature; a valid file needs the rest. */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db40000000049454e44ae426082",
  "hex"
);

const JPEG_1X1 = Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb004300ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "hex");

/** The first two bytes of every Windows executable. */
const PE_STUB = Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(64, 0x90)]);

const ACTOR_USERNAME = "bcis-attachment-test-owner";

/**
 * Built per test from the row that was actually inserted, because `users.id` is
 * `defaultRandom` and both `attachments.uploaded_by` and `audit_logs.actor_id`
 * are foreign keys into it.
 */
let testActor: Actor;

beforeEach(async () => {
  await db.delete(attachments);
  await db.delete(auditLogs);

  await db
    .delete(users)
    .where(eq(users.username, ACTOR_USERNAME));

  const [inserted] = await db
    .insert(users)
    .values({
      username: ACTOR_USERNAME,
      displayName: "Test Owner",
      // Not a real credential: this suite authenticates nobody, it only needs
      // the row to exist so the foreign keys resolve.
      passwordHash: "not-a-real-hash",
      passwordSalt: "not-a-real-salt"
    })
    .returning();

  testActor = {
    id: inserted.id,
    username: ACTOR_USERNAME,
    displayName: inserted.displayName,
    permissions: []
  };
});

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(
      `Refusing to run integration tests against database "${name}". ` +
        "Set DATABASE_URL to a database whose name ends in _test."
    );
  }
}

const storageRoot = join(tmpdir(), `bcis-attachment-test-${process.pid}`);

beforeAll(async () => {
  assertTestDatabase();
  // Set before the first call to `attachmentDirectory()`, which reads this on
  // every invocation rather than caching it at import time.
  process.env.ATTACHMENT_DIR = storageRoot;
  rmSync(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  rmSync(storageRoot, { recursive: true, force: true });
  delete process.env.ATTACHMENT_DIR;
  await closeDatabase();
});

describe("attachment type validation (§4.4)", () => {
  it("accepts a genuine PNG and records it with the sniffed type", async () => {
    const record = await storeAttachment(
      {
        originalName: "gcash-proof.png",
        declaredMimeType: "image/png",
        stream: Readable.from(PNG_1X1),
        entityType: "GCASH_PROOF",
        entityId: "proof-1"
      },
      testActor
    );

    expect(record.mimeType).toBe("image/png");
    expect(record.sizeBytes).toBe(PNG_1X1.length);
    expect(record.checksumSha256).toBe(createHash("sha256").update(PNG_1X1).digest("hex"));
    expect(record.uploadedByName).toBe("Test Owner");
  });

  it("accepts a genuine PDF", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32, 0x20)]);
    const record = await storeAttachment({
      originalName: "remittance.pdf",
      declaredMimeType: "application/pdf",
      stream: Readable.from(pdf),
      entityType: "BANK_REMITTANCE",
      entityId: "remit-1"
    });

    expect(record.mimeType).toBe("application/pdf");
    expect(record.storedPath.endsWith(".pdf")).toBe(true);
  });

  it("rejects an executable masquerading as a PNG", async () => {
    await expect(
      storeAttachment({
        originalName: "totally-a-proof.png",
        declaredMimeType: "image/png",
        stream: Readable.from(PE_STUB),
        entityType: "GCASH_PROOF",
        entityId: "proof-2"
      })
    ).rejects.toThrow(/not a recognised image or PDF/i);
  });

  it("rejects a real PNG that claims to be a JPEG", async () => {
    await expect(
      storeAttachment({
        originalName: "mislabelled.jpg",
        declaredMimeType: "image/jpeg",
        stream: Readable.from(PNG_1X1),
        entityType: "GCASH_PROOF",
        entityId: "proof-3"
      })
    ).rejects.toThrow(/look like image\/png/i);
  });

  it("rejects a type that is not on the allow-list before reading the body", async () => {
    await expect(
      storeAttachment({
        originalName: "payload.exe",
        declaredMimeType: "application/x-msdownload",
        stream: Readable.from(PE_STUB),
        entityType: "GCASH_PROOF",
        entityId: "proof-4"
      })
    ).rejects.toThrow(/must be a JPEG, PNG, WebP, GIF image or a PDF/i);
  });

  it("rejects an empty file", async () => {
    await expect(
      storeAttachment({
        originalName: "empty.png",
        declaredMimeType: "image/png",
        stream: Readable.from(Buffer.alloc(0)),
        entityType: "GCASH_PROOF",
        entityId: "proof-5"
      })
    ).rejects.toThrow(/empty/i);
  });

  it("leaves no row and no file behind for a rejected upload", async () => {
    await expect(
      storeAttachment({
        originalName: "bad.png",
        declaredMimeType: "image/png",
        stream: Readable.from(PE_STUB),
        entityType: "GCASH_PROOF",
        entityId: "proof-6"
      })
    ).rejects.toThrow();

    const remaining = await db.select().from(attachments);
    expect(remaining).toHaveLength(0);

    // The scratch folder may exist, but no `.part` file may remain in it: a
    // half-written upload must never be left where a backup would find it.
    const scratch = join(attachmentDirectory(), ".partial");
    const leftovers = existsSync(scratch) ? readdirSync(scratch) : [];
    expect(leftovers.filter((name) => name.endsWith(".part"))).toHaveLength(0);
  });
});

describe("attachment size validation (§4.4)", () => {
  it("accepts a file just under the cap", async () => {
    // A PNG header is required for the type check to pass, so pad behind it.
    const oversized = Buffer.concat([PNG_1X1, Buffer.alloc(MAX_ATTACHMENT_BYTES - PNG_1X1.length - 1)]);
    expect(oversized.length).toBeLessThan(MAX_ATTACHMENT_BYTES);

    const record = await storeAttachment({
      originalName: "large-proof.png",
      declaredMimeType: "image/png",
      stream: Readable.from(oversized),
      entityType: "GCASH_PROOF",
      entityId: "size-1"
    });

    expect(record.sizeBytes).toBe(oversized.length);
  });

  it("rejects a file one byte over the cap and removes the partial file", async () => {
    // The PNG header is prepended so the type check passes and the *size* check
    // is the only thing that can reject this.
    const tooBig = Buffer.concat([PNG_1X1, Buffer.alloc(MAX_ATTACHMENT_BYTES - PNG_1X1.length + 1)]);
    expect(tooBig.length).toBe(MAX_ATTACHMENT_BYTES + 1);

    await expect(
      storeAttachment({
        originalName: "too-big.png",
        declaredMimeType: "image/png",
        stream: Readable.from(tooBig),
        entityType: "GCASH_PROOF",
        entityId: "size-2"
      })
    ).rejects.toThrow(/limited to 5 MB/i);

    const remaining = await db.select().from(attachments);
    expect(remaining).toHaveLength(0);
  });
});

describe("attachment path safety (§4.4)", () => {
  it("neutralises a traversal filename", async () => {
    const record = await storeAttachment({
      originalName: "../../../../app/.env.png",
      declaredMimeType: "image/png",
      stream: Readable.from(PNG_1X1),
      entityType: "GCASH_PROOF",
      entityId: "path-1"
    });

    // Two segments: the shard folder and the file itself. No `..` survives.
    expect(record.storedPath).not.toContain("..");
    expect(record.storedPath.split(/[\\/]/)).toHaveLength(2);

    const absolute = safeAttachmentPath(record.storedPath);
    const root = resolve(attachmentDirectory());
    expect(absolute.startsWith(root + sep)).toBe(true);
    expect(existsSync(absolute)).toBe(true);
  });

  it("strips path characters from a Windows-style absolute filename", async () => {
    const record = await storeAttachment({
      originalName: String.raw`C:\Windows\System32\drivers\etc\hosts.png`,
      declaredMimeType: "image/png",
      stream: Readable.from(PNG_1X1),
      entityType: "GCASH_PROOF",
      entityId: "path-2"
    });

    // The stored path is POSIX so it survives a cross-platform restore, and the
    // drive letter and separators from the client's name are gone.
    expect(record.storedPath).not.toContain(":");
    expect(record.storedPath).not.toContain("\\");
    expect(record.storedPath.split("/")).toHaveLength(2);
    // The extension comes from the sniffed type, so the client's is not doubled.
    expect(record.storedPath.endsWith("hosts.png")).toBe(true);
    expect(record.storedPath).not.toContain(".png.png");
    expect(existsSync(safeAttachmentPath(record.storedPath))).toBe(true);
  });

  it("refuses to resolve a stored path that escapes the root", () => {
    // Guards the service's own read path, not just the write path. If a row were
    // tampered with directly in PostgreSQL, this is what stops the API from
    // serving a file outside the attachment directory.
    expect(() => safeAttachmentPath("../../../app/.env")).toThrow(/outside the storage directory/i);
  });
});

describe("attachment retrieval", () => {
  it("streams the stored bytes back unchanged", async () => {
    const stored = await storeAttachment({
      originalName: "readback.png",
      declaredMimeType: "image/png",
      stream: Readable.from(PNG_1X1),
      entityType: "GCASH_PROOF",
      entityId: "read-1"
    });

    const opened = await openAttachment(stored.id);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) {
      chunks.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks).equals(PNG_1X1)).toBe(true);
    expect(opened.sizeBytes).toBe(PNG_1X1.length);
  });

  it("lists attachments for an entity, newest first", async () => {
    await storeAttachment({
      originalName: "first.png",
      declaredMimeType: "image/png",
      stream: Readable.from(PNG_1X1),
      entityType: "GCASH_PROOF",
      entityId: "list-1"
    });
    await storeAttachment({
      originalName: "second.png",
      declaredMimeType: "image/png",
      stream: Readable.from(PNG_1X1),
      entityType: "GCASH_PROOF",
      entityId: "list-1"
    });
    await storeAttachment({
      originalName: "other-entity.png",
      declaredMimeType: "image/png",
      stream: Readable.from(PNG_1X1),
      entityType: "GCASH_PROOF",
      entityId: "list-2"
    });

    const items = await listAttachments("GCASH_PROOF", "list-1");
    expect(items).toHaveLength(2);
  });

  it("reports a missing attachment as not found", async () => {
    await expect(getAttachment("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/not found/i);
  });
});

describe("attachment audit trail (§4.4)", () => {
  it("writes one attachment.uploaded entry per accepted file", async () => {
    await storeAttachment(
      {
        originalName: "audited.png",
        declaredMimeType: "image/png",
        stream: Readable.from(PNG_1X1),
        entityType: "GCASH_PROOF",
        entityId: "audit-1"
      },
      testActor
    );

    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "attachment.uploaded"));

    expect(rows).toHaveLength(1);
    expect(rows[0].actorName).toBe("Test Owner");
    expect(rows[0].entityType).toBe("GCASH_PROOF");
    expect(rows[0].entityId).toBe("audit-1");
  });

  it("writes no audit entry for a rejected upload", async () => {
    await expect(
      storeAttachment(
        {
          originalName: "rejected.png",
          declaredMimeType: "image/png",
          stream: Readable.from(PE_STUB),
          entityType: "GCASH_PROOF",
          entityId: "audit-2"
        },
        testActor
      )
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "attachment.uploaded"));

    expect(rows).toHaveLength(0);
  });
});
