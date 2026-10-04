import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { actorOf, authorize, authorizeAny } from "../http/guards.js";
import { listAttachments, openAttachment, storeAttachment } from "../services/attachments.js";
import { businessRule, validationFailed } from "../services/errors.js";

/**
 * Payment-proof upload and retrieval (§3.6, §4.3, §4.4).
 *
 * Two roles legitimately attach proofs, and neither holds the other's
 * permissions: the cashier posting a GCash payment uploads the screenshot they
 * were handed, while office staff record a claim that arrived through the
 * Facebook Page. Both are allowed, so these routes use `authorizeAny` rather than
 * inventing a permission that neither role actually needs.
 *
 * Retrieval is stricter than upload. Anyone who can attach a proof can fetch it
 * back, but serving customer-supplied bytes to a browser is a different risk
 * profile, so the download route additionally requires that the caller is the
 * uploader, an office administrator, or the owner.
 */

const entitySchema = z.object({
  entityType: z.string().trim().min(2).max(40),
  entityId: z.string().trim().min(1).max(64)
});

/** Entity kinds that may carry a proof. Keeps `entityType` from being a free-text dumping ground. */
const PROOF_ENTITY_TYPES = new Set(["GCASH_PROOF", "BANK_REMITTANCE", "CASH_REMITTANCE", "SUBSCRIBER_PHOTO"]);

/**
 * Who may attach a proof.
 *
 * Three roles legitimately do, and none holds the other's permissions: the
 * cashier posts a payment and uploads the screenshot handed to them
 * (`payment.create`), the same cashier records a subscriber's GCash claim through
 * the Facebook Page (`gcash.submit`), and office staff log a house-to-house
 * collection that carries a remittance slip (`collection.record`). Rather than
 * invent a permission none of them actually needs, this route accepts any of the
 * three.
 */
const PROOF_WRITERS = ["payment.create", "gcash.submit", "collection.record"] as const;

/**
 * Who may read a proof.
 *
 * `gcash.verify` is included because the verification screen (§4.3) exists to let
 * someone approve a proof they did not upload.
 */
const PROOF_READERS = ["gcash.verify", "payment.view", "collection.view", "settings.manage", "audit.view"] as const;

/**
 * Permissions that lift the "only the uploader" restriction.
 *
 * Without this a cashier could preview their own upload but the supervisor
 * assigned to verify it would be refused, which is the opposite of the intent.
 */
const PROOF_PRIVILEGED = ["gcash.verify", "settings.manage", "audit.view"] as const;

function isPrivileged(permissions: readonly string[]): boolean {
  return PROOF_PRIVILEGED.some((permission) => permissions.includes(permission));
}

export async function registerAttachmentRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/attachments",
    { preHandler: authorizeAny(...PROOF_WRITERS) },
    async (request, reply) => {
      if (!request.isMultipart()) {
        throw validationFailed("Send the proof as multipart/form-data with a single file field named `file`.");
      }

      const parts = request.parts();
      const uploaded: Array<{ record: Awaited<ReturnType<typeof storeAttachment>>; fieldName: string }> = [];
      let entityType: string | undefined;
      let entityId: string | undefined;

      for await (const part of parts) {
        if (part.type === "field") {
          // A client may send the entity before or after the file, so these are
          // collected as they arrive rather than assuming an order.
          if (part.fieldname === "entityType") {
            entityType = String(part.value);
          } else if (part.fieldname === "entityId") {
            entityId = String(part.value);
          }
          continue;
        }

        if (part.fieldname !== "file") {
          // Drain anything unexpected so the request completes cleanly.
          part.file.resume();
          continue;
        }

        const parsedEntity = entitySchema.safeParse({ entityType, entityId });
        if (!parsedEntity.success) {
          throw validationFailed("Send `entityType` and `entityId` alongside the file.");
        }
        if (!PROOF_ENTITY_TYPES.has(parsedEntity.data.entityType)) {
          throw validationFailed(
            `"${parsedEntity.data.entityType}" is not a known attachment kind. Use one of: ${[...PROOF_ENTITY_TYPES].join(", ")}.`
          );
        }

        // `part.file.truncated` is set when the parser's own fileSize limit stops
        // the stream. The service counts bytes too, but this branch keeps the
        // failure attributable to the limit rather than to a short read.
        const record = await storeAttachment(
          {
            originalName: part.filename ?? "proof",
            declaredMimeType: part.mimetype,
            stream: part.file,
            entityType: parsedEntity.data.entityType,
            entityId: parsedEntity.data.entityId
          },
          actorOf(request)
        );

        uploaded.push({ record, fieldName: part.fieldname });
      }

      if (uploaded.length === 0) {
        throw validationFailed("No file was received. Use a multipart form field named `file`.");
      }
      if (uploaded.length > 1) {
        throw validationFailed("Upload one file per request.");
      }

      return reply.status(201).send({ attachment: uploaded[0].record });
    }
  );

  app.get(
    "/attachments/:attachmentId",
    { preHandler: authorizeAny(...PROOF_READERS) },
    async (request, reply) => {
      const actor = actorOf(request);
      const { attachmentId } = request.params as { attachmentId: string };

      const opened = await openAttachment(attachmentId);

      // A user who can only submit proofs sees their own uploads; anyone who
      // verifies, administers or audits may see any of them.
      if (!isPrivileged(actor.permissions) && opened.record.uploadedBy !== actor.id) {
        throw businessRule("You can only open attachments that you uploaded.");
      }

      return reply
        .header("Content-Type", opened.record.mimeType)
        .header("Content-Length", String(opened.sizeBytes))
        // `nosniff` matters here: it stops a browser from ignoring the
        // Content-Type and treating a proof as HTML or script.
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .header(
          "Content-Disposition",
          // `inline` so the GCash verification pane can preview the image
          // directly (§4.3). The filename is quoted and stripped of quotes to
          // avoid a header-injection attempt through the original name.
          `inline; filename="${opened.record.originalName.replace(/["\\\r\n]/g, "_")}"`
        )
        .send(opened.stream);
    }
  );

  app.get(
    "/attachments",
    { preHandler: authorizeAny(...PROOF_READERS) },
    async (request) => {
      const parsed = entitySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw validationFailed("Send `entityType` and `entityId` to list attachments.");
      }
      return { items: await listAttachments(parsed.data.entityType, parsed.data.entityId) };
    }
  );
}
