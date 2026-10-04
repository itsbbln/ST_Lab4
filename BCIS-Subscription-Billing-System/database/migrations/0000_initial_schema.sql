CREATE TYPE "public"."allocation_type" AS ENUM('AUTO', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('CREATED', 'VERIFIED', 'RESTORED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."batch_account_status" AS ENUM('PENDING', 'COLLECTED', 'PARTIAL', 'UNCOLLECTED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."collection_batch_status" AS ENUM('OPEN', 'IN_PROGRESS', 'SUBMITTED', 'REMITTED', 'RECONCILED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."billing_cycle_status" AS ENUM('OPEN', 'GENERATED', 'FINALIZED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."invoice_item_type" AS ENUM('SUBSCRIPTION', 'INSTALLATION', 'RECONNECTION', 'DISCOUNT', 'PENALTY', 'ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID', 'CREDITED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'GCASH', 'BANK_TRANSFER', 'CHEQUE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."proof_status" AS ENUM('PENDING', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."reconnection_status" AS ENUM('PENDING_PAYMENT', 'REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."remittance_status" AS ENUM('DRAFT', 'SUBMITTED', 'CONFIRMED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."service_account_status" AS ENUM('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'DISCONNECTED', 'TERMINATED');--> statement-breakpoint
CREATE TYPE "public"."service_event_type" AS ENUM('CREATED', 'ACTIVATED', 'PLAN_CHANGED', 'RATE_CHANGED', 'SUSPENDED', 'RECONNECTED', 'DISCONNECTED', 'TERMINATED', 'ADDRESS_CHANGED', 'COLLECTOR_CHANGED');--> statement-breakpoint
CREATE TYPE "public"."service_type_code" AS ENUM('INTERNET', 'CABLE', 'COMBO');--> statement-breakpoint
CREATE TYPE "public"."subscriber_status" AS ENUM('ACTIVE', 'INACTIVE', 'TERMINATED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."suspension_status" AS ENUM('PENDING', 'APPROVED', 'EXECUTED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "permissions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" text NOT NULL,
	"description" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" integer NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"password_hash" text NOT NULL,
	"password_salt" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_failed_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"full_name" text NOT NULL,
	"contact_number" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"service_type_id" uuid NOT NULL,
	"monthly_price_centavos" bigint NOT NULL,
	"installation_fee_centavos" bigint DEFAULT 0 NOT NULL,
	"reconnection_fee_centavos" bigint DEFAULT 0 NOT NULL,
	"speed_mbps" integer,
	"channel_count" integer,
	"description" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "service_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriber_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"label" text NOT NULL,
	"address_line" text NOT NULL,
	"city" text NOT NULL,
	"is_principal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_number" text NOT NULL,
	"full_name" text NOT NULL,
	"contact_number" text NOT NULL,
	"email" text,
	"address_line" text NOT NULL,
	"city" text NOT NULL,
	"collection_area_id" uuid NOT NULL,
	"billing_due_day" integer DEFAULT 5 NOT NULL,
	"status" "subscriber_status" DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "technicians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"full_name" text NOT NULL,
	"contact_number" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_number" text NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"installation_address" text NOT NULL,
	"activation_date" date NOT NULL,
	"billing_start_period" text NOT NULL,
	"billing_due_day" integer DEFAULT 5 NOT NULL,
	"current_rate_centavos" bigint NOT NULL,
	"status" "service_account_status" DEFAULT 'PENDING_ACTIVATION' NOT NULL,
	"collector_id" uuid,
	"credit_balance_centavos" bigint DEFAULT 0 NOT NULL,
	"suspended_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "service_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"device_type" text NOT NULL,
	"serial_number" text,
	"model" text,
	"status" text DEFAULT 'INSTALLED' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "service_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"event_type" "service_event_type" NOT NULL,
	"reason" text,
	"effective_date" date NOT NULL,
	"notes" text,
	"actor_id" uuid,
	"actor_name" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period" text NOT NULL,
	"status" "billing_cycle_status" DEFAULT 'OPEN' NOT NULL,
	"generated_at" timestamp with time zone,
	"generated_by" uuid,
	"generated_by_name" text,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"total_billed_centavos" bigint DEFAULT 0 NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"adjustment_type" "invoice_item_type" NOT NULL,
	"reason" text NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"previous_total_centavos" bigint NOT NULL,
	"new_total_centavos" bigint NOT NULL,
	"requested_by" uuid,
	"requested_by_name" text,
	"approved_by" uuid,
	"approved_by_name" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"item_type" "invoice_item_type" NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(10, 2) DEFAULT '1' NOT NULL,
	"unit_price_centavos" bigint NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text NOT NULL,
	"service_account_id" uuid NOT NULL,
	"billing_cycle_id" uuid,
	"period" text NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"subtotal_centavos" bigint NOT NULL,
	"discount_centavos" bigint DEFAULT 0 NOT NULL,
	"penalty_centavos" bigint DEFAULT 0 NOT NULL,
	"total_centavos" bigint NOT NULL,
	"paid_centavos" bigint DEFAULT 0 NOT NULL,
	"balance_centavos" bigint NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"rate_snapshot_centavos" bigint NOT NULL,
	"is_finalized" boolean DEFAULT false NOT NULL,
	"finalized_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"allocation_type" "allocation_type" DEFAULT 'AUTO' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"reference_number" text NOT NULL,
	"sender_name" text NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"proof_note" text,
	"attachment_id" uuid,
	"status" "proof_status" DEFAULT 'PENDING' NOT NULL,
	"submitted_by" uuid,
	"submitted_by_name" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_by" uuid,
	"verified_by_name" text,
	"verified_at" timestamp with time zone,
	"rejection_reason" text,
	"payment_id" uuid,
	"is_duplicate_suspect" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reversal_number" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"unallocated_centavos" bigint NOT NULL,
	"credit_restored_centavos" bigint NOT NULL,
	"reversed_by" uuid,
	"reversed_by_name" text,
	"reversed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_number" text NOT NULL,
	"service_account_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"payment_date" timestamp with time zone DEFAULT now() NOT NULL,
	"amount_centavos" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference_number" text,
	"notes" text,
	"status" "payment_status" DEFAULT 'POSTED' NOT NULL,
	"allocated_centavos" bigint DEFAULT 0 NOT NULL,
	"advance_centavos" bigint DEFAULT 0 NOT NULL,
	"credit_applied_centavos" bigint DEFAULT 0 NOT NULL,
	"posted_by" uuid,
	"posted_by_name" text,
	"collector_id" uuid,
	"batch_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_number" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"issued_by" uuid,
	"issued_by_name" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"posting_date" timestamp with time zone DEFAULT now() NOT NULL,
	"reference" text NOT NULL,
	"description" text NOT NULL,
	"entry_type" text NOT NULL,
	"debit_centavos" bigint DEFAULT 0 NOT NULL,
	"credit_centavos" bigint DEFAULT 0 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"created_by" uuid,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"service_account_id" uuid NOT NULL,
	"current_bill_centavos" bigint DEFAULT 0 NOT NULL,
	"arrears_centavos" bigint DEFAULT 0 NOT NULL,
	"total_due_centavos" bigint DEFAULT 0 NOT NULL,
	"collected_centavos" bigint DEFAULT 0 NOT NULL,
	"status" "batch_account_status" DEFAULT 'PENDING' NOT NULL,
	"collection_notes" text,
	"collected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_number" text NOT NULL,
	"area_id" uuid NOT NULL,
	"route_id" uuid,
	"collector_id" uuid NOT NULL,
	"batch_date" date NOT NULL,
	"due_day_cutoff" integer DEFAULT 31 NOT NULL,
	"status" "collection_batch_status" DEFAULT 'OPEN' NOT NULL,
	"account_count" integer DEFAULT 0 NOT NULL,
	"expected_receivable_centavos" bigint DEFAULT 0 NOT NULL,
	"cash_collected_centavos" bigint DEFAULT 0 NOT NULL,
	"non_cash_collected_centavos" bigint DEFAULT 0 NOT NULL,
	"total_collected_centavos" bigint DEFAULT 0 NOT NULL,
	"uncollected_centavos" bigint DEFAULT 0 NOT NULL,
	"opened_by" uuid,
	"opened_by_name" text,
	"submitted_at" timestamp with time zone,
	"remitted_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" uuid,
	"reconciled_by_name" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collector_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collector_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"route_id" uuid,
	"service_account_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"assigned_by" uuid,
	"assigned_by_name" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collector_remittances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"remittance_number" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"collector_id" uuid NOT NULL,
	"remittance_date" date NOT NULL,
	"cash_collected_centavos" bigint DEFAULT 0 NOT NULL,
	"cash_remitted_centavos" bigint DEFAULT 0 NOT NULL,
	"non_cash_collected_centavos" bigint DEFAULT 0 NOT NULL,
	"difference_centavos" bigint DEFAULT 0 NOT NULL,
	"shortage_centavos" bigint DEFAULT 0 NOT NULL,
	"overage_centavos" bigint DEFAULT 0 NOT NULL,
	"status" "remittance_status" DEFAULT 'DRAFT' NOT NULL,
	"submitted_by" uuid,
	"submitted_by_name" text,
	"submitted_at" timestamp with time zone,
	"confirmed_by" uuid,
	"confirmed_by_name" text,
	"confirmed_at" timestamp with time zone,
	"rejection_reason" text,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconnection_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"suspension_id" uuid,
	"fee_centavos" bigint DEFAULT 0 NOT NULL,
	"invoice_id" uuid,
	"technician_id" uuid,
	"request_date" date NOT NULL,
	"requested_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"status" "reconnection_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"approved_by" uuid,
	"approved_by_name" text,
	"cancelled_at" timestamp with time zone,
	"notes" text,
	"created_by" uuid,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suspension_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"effective_date" date NOT NULL,
	"arrears_at_suspension_centavos" bigint DEFAULT 0 NOT NULL,
	"status" "suspension_status" DEFAULT 'PENDING' NOT NULL,
	"approved_by" uuid,
	"approved_by_name" text,
	"approved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"notes" text,
	"created_by" uuid,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"value_label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'GENERAL' NOT NULL,
	"updated_by" uuid,
	"updated_by_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"original_name" text NOT NULL,
	"stored_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"uploaded_by" uuid,
	"uploaded_by_name" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_username" text DEFAULT 'system' NOT NULL,
	"actor_name" text DEFAULT 'System' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"reason" text,
	"old_values" jsonb,
	"new_values" jsonb,
	"ip_address" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backup_id" text NOT NULL,
	"file_name" text NOT NULL,
	"file_path" text NOT NULL,
	"file_size_bytes" bigint DEFAULT 0 NOT NULL,
	"checksum" text,
	"checksum_algorithm" text DEFAULT 'sha256' NOT NULL,
	"status" "backup_status" DEFAULT 'CREATED' NOT NULL,
	"includes_attachments" boolean DEFAULT true NOT NULL,
	"table_counts" jsonb,
	"created_by" uuid,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_name" text,
	"restored_at" timestamp with time zone,
	"restored_by_name" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"document_type" text NOT NULL,
	"year" integer NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_sequences_document_type_year_pk" PRIMARY KEY("document_type","year")
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_routes" ADD CONSTRAINT "collection_routes_area_id_collection_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."collection_areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_addresses" ADD CONSTRAINT "subscriber_addresses_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_collection_area_id_collection_areas_id_fk" FOREIGN KEY ("collection_area_id") REFERENCES "public"."collection_areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_plan_id_service_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."service_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_devices" ADD CONSTRAINT "service_devices_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billing_cycle_id_billing_cycles_id_fk" FOREIGN KEY ("billing_cycle_id") REFERENCES "public"."billing_cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_batch_id_collection_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."collection_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_accounts" ADD CONSTRAINT "batch_accounts_batch_id_collection_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."collection_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_accounts" ADD CONSTRAINT "batch_accounts_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_area_id_collection_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."collection_areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_route_id_collection_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."collection_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_area_id_collection_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."collection_areas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_route_id_collection_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."collection_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_remittances" ADD CONSTRAINT "collector_remittances_batch_id_collection_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."collection_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_remittances" ADD CONSTRAINT "collector_remittances_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_suspension_id_suspension_records_id_fk" FOREIGN KEY ("suspension_id") REFERENCES "public"."suspension_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspension_records" ADD CONSTRAINT "suspension_records_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_settings" ADD CONSTRAINT "application_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_history" ADD CONSTRAINT "backup_history_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_code_unique" ON "permissions" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_code_unique" ON "roles" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_unique" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "users_display_name_idx" ON "users" USING btree ("display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_areas_code_unique" ON "collection_areas" USING btree (lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "collection_routes_code_unique" ON "collection_routes" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "collection_routes_area_idx" ON "collection_routes" USING btree ("area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collectors_code_unique" ON "collectors" USING btree (lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "service_plans_code_unique" ON "service_plans" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "service_plans_service_type_idx" ON "service_plans" USING btree ("service_type_id");--> statement-breakpoint
CREATE INDEX "service_plans_active_idx" ON "service_plans" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "service_types_code_unique" ON "service_types" USING btree ("code");--> statement-breakpoint
CREATE INDEX "subscriber_addresses_subscriber_idx" ON "subscriber_addresses" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "subscriber_addresses_text_idx" ON "subscriber_addresses" USING btree (lower("address_line"));--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_account_number_unique" ON "subscribers" USING btree (upper("account_number"));--> statement-breakpoint
CREATE INDEX "subscribers_full_name_idx" ON "subscribers" USING btree (lower("full_name"));--> statement-breakpoint
CREATE INDEX "subscribers_contact_number_idx" ON "subscribers" USING btree (right("contact_number", 10));--> statement-breakpoint
CREATE INDEX "subscribers_area_idx" ON "subscribers" USING btree ("collection_area_id");--> statement-breakpoint
CREATE INDEX "subscribers_status_idx" ON "subscribers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "technicians_code_unique" ON "technicians" USING btree (lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "service_accounts_number_unique" ON "service_accounts" USING btree (upper("service_account_number"));--> statement-breakpoint
CREATE INDEX "service_accounts_subscriber_idx" ON "service_accounts" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "service_accounts_plan_idx" ON "service_accounts" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "service_accounts_collector_idx" ON "service_accounts" USING btree ("collector_id");--> statement-breakpoint
CREATE INDEX "service_accounts_status_idx" ON "service_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "service_accounts_billing_start_idx" ON "service_accounts" USING btree ("billing_start_period");--> statement-breakpoint
CREATE INDEX "service_devices_account_idx" ON "service_devices" USING btree ("service_account_id");--> statement-breakpoint
CREATE INDEX "service_devices_serial_idx" ON "service_devices" USING btree ("serial_number");--> statement-breakpoint
CREATE INDEX "service_events_account_idx" ON "service_events" USING btree ("service_account_id","effective_date");--> statement-breakpoint
CREATE INDEX "service_events_type_idx" ON "service_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_cycles_period_unique" ON "billing_cycles" USING btree ("period");--> statement-breakpoint
CREATE INDEX "billing_cycles_status_idx" ON "billing_cycles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoice_adjustments_invoice_idx" ON "invoice_adjustments" USING btree ("invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "invoice_items_invoice_idx" ON "invoice_items" USING btree ("invoice_id","sort_order");--> statement-breakpoint
CREATE INDEX "invoice_items_type_idx" ON "invoice_items" USING btree ("item_type");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_unique" ON "invoices" USING btree (upper("invoice_number"));--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_account_period_unique" ON "invoices" USING btree ("service_account_id","period") WHERE "invoices"."status" <> 'VOID';--> statement-breakpoint
CREATE INDEX "invoices_due_date_status_idx" ON "invoices" USING btree ("due_date","status");--> statement-breakpoint
CREATE INDEX "invoices_period_idx" ON "invoices" USING btree ("period");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoices_balance_idx" ON "invoices" USING btree ("balance_centavos");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_payment_invoice_unique" ON "payment_allocations" USING btree ("payment_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_proofs_status_idx" ON "payment_proofs" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "payment_proofs_reference_idx" ON "payment_proofs" USING btree (upper("reference_number"));--> statement-breakpoint
CREATE INDEX "payment_proofs_account_idx" ON "payment_proofs" USING btree ("service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reversals_number_unique" ON "payment_reversals" USING btree (upper("reversal_number"));--> statement-breakpoint
CREATE INDEX "payment_reversals_payment_idx" ON "payment_reversals" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receipt_number_unique" ON "payments" USING btree (upper("receipt_number"));--> statement-breakpoint
CREATE INDEX "payments_account_date_idx" ON "payments" USING btree ("service_account_id","payment_date");--> statement-breakpoint
CREATE INDEX "payments_date_idx" ON "payments" USING btree ("payment_date");--> statement-breakpoint
CREATE INDEX "payments_method_date_idx" ON "payments" USING btree ("method","payment_date");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gcash_reference_unique" ON "payments" USING btree (upper("reference_number")) WHERE "payments"."method" = 'GCASH' AND "payments"."status" = 'POSTED' AND "payments"."reference_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_collector_idx" ON "payments" USING btree ("collector_id");--> statement-breakpoint
CREATE INDEX "payments_batch_idx" ON "payments" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_number_unique" ON "receipts" USING btree (upper("receipt_number"));--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_payment_unique" ON "receipts" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "receipts_issued_idx" ON "receipts" USING btree ("issued_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_date_idx" ON "ledger_entries" USING btree ("service_account_id","entry_date","posting_date");--> statement-breakpoint
CREATE INDEX "ledger_entries_reference_idx" ON "ledger_entries" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "ledger_entries_source_idx" ON "ledger_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_accounts_batch_account_unique" ON "batch_accounts" USING btree ("batch_id","service_account_id");--> statement-breakpoint
CREATE INDEX "batch_accounts_batch_status_idx" ON "batch_accounts" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "batch_accounts_account_idx" ON "batch_accounts" USING btree ("service_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_batches_number_unique" ON "collection_batches" USING btree (upper("batch_number"));--> statement-breakpoint
CREATE INDEX "collection_batches_collector_date_idx" ON "collection_batches" USING btree ("collector_id","batch_date");--> statement-breakpoint
CREATE INDEX "collection_batches_status_idx" ON "collection_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "collection_batches_area_idx" ON "collection_batches" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "collector_assignments_account_idx" ON "collector_assignments" USING btree ("service_account_id","effective_from");--> statement-breakpoint
CREATE INDEX "collector_assignments_collector_idx" ON "collector_assignments" USING btree ("collector_id");--> statement-breakpoint
CREATE INDEX "collector_assignments_area_idx" ON "collector_assignments" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "collector_assignments_route_idx" ON "collector_assignments" USING btree ("route_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collector_remittances_number_unique" ON "collector_remittances" USING btree (upper("remittance_number"));--> statement-breakpoint
CREATE INDEX "collector_remittances_batch_idx" ON "collector_remittances" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "collector_remittances_collector_idx" ON "collector_remittances" USING btree ("collector_id","remittance_date");--> statement-breakpoint
CREATE INDEX "collector_remittances_status_idx" ON "collector_remittances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reconnection_records_account_idx" ON "reconnection_records" USING btree ("service_account_id","request_date");--> statement-breakpoint
CREATE INDEX "reconnection_records_status_idx" ON "reconnection_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reconnection_records_technician_idx" ON "reconnection_records" USING btree ("technician_id");--> statement-breakpoint
CREATE INDEX "suspension_records_account_idx" ON "suspension_records" USING btree ("service_account_id","effective_date");--> statement-breakpoint
CREATE INDEX "suspension_records_status_idx" ON "suspension_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "attachments_checksum_idx" ON "attachments" USING btree ("checksum_sha256");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_history_backup_id_unique" ON "backup_history" USING btree ("backup_id");--> statement-breakpoint
CREATE INDEX "backup_history_status_idx" ON "backup_history" USING btree ("status");--> statement-breakpoint
CREATE INDEX "backup_history_created_idx" ON "backup_history" USING btree ("created_at");