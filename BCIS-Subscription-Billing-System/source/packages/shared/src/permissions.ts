/**
 * Role-Based Access Control definitions.
 *
 * The laboratory specification requires granular permissions such as
 * `subscriber.view`, `billing.generate`, `payment.create`, `payment.reverse`,
 * `collection.reconcile`, `report.export`, `user.manage` and `backup.restore`,
 * and requires that authorization is enforced on the server. Hiding a button in
 * React is never treated as authorization anywhere in this codebase.
 */

export const permissions = [
  "dashboard.view",
  "subscriber.view",
  "subscriber.manage",
  "plan.manage",
  "service.view",
  "service.manage",
  "billing.view",
  "billing.generate",
  "payment.view",
  "payment.create",
  "payment.reverse",
  "gcash.submit",
  "gcash.verify",
  "collection.view",
  "collection.record",
  "collection.reconcile",
  "receivables.view",
  "suspension.manage",
  "report.view",
  "report.export",
  "user.manage",
  "settings.manage",
  "audit.view",
  "backup.restore"
] as const;

export type Permission = (typeof permissions)[number];

export const roleCodes = [
  "OWNER",
  "ADMINISTRATOR",
  "CASHIER",
  "COLLECTION_SUPERVISOR",
  "ACCOUNTANT_AUDITOR",
  "TECHNICIAN",
  "READONLY_VIEWER"
] as const;

export type RoleCode = (typeof roleCodes)[number];

export const permissionDescriptions: Record<Permission, string> = {
  "dashboard.view": "View the management dashboard and KPIs",
  "subscriber.view": "View subscribers, service accounts and global search",
  "subscriber.manage": "Create and maintain subscribers, addresses and area assignment",
  "plan.manage": "Create and maintain service plans, prices and fees",
  "service.view": "View service accounts, service history and devices",
  "service.manage": "Create and maintain service accounts",
  "billing.view": "View invoices, billing cycles and ledgers",
  "billing.generate": "Generate monthly invoices",
  "payment.view": "View payment history and receipts",
  "payment.create": "Receive and post payments with allocation",
  "payment.reverse": "Reverse a posted payment with an audited reason",
  "gcash.submit": "Record a GCash proof submitted by a subscriber",
  "gcash.verify": "Verify or reject a GCash proof",
  "collection.view": "View areas, routes, collectors and batches",
  "collection.record": "Record house-to-house collections on a batch",
  "collection.reconcile": "Submit, reconcile and close collector remittances",
  "receivables.view": "View outstanding, overdue and aging receivables",
  "suspension.manage": "Approve suspensions and execute reconnections",
  "report.view": "View management reports and audit trails",
  "report.export": "Export reports to PDF, XLSX or CSV",
  "user.manage": "Create, update, deactivate and assign roles to users",
  "settings.manage": "Change application settings such as penalty and grace period",
  "audit.view": "View the immutable audit trail",
  "backup.restore": "Create, verify and restore database backups"
};

const readOnlyPermissions: Permission[] = [
  "dashboard.view",
  "subscriber.view",
  "service.view",
  "billing.view",
  "payment.view",
  "collection.view",
  "receivables.view",
  "report.view"
];

export const rolePermissions: Record<RoleCode, Permission[]> = {
  OWNER: [...permissions],
  ADMINISTRATOR: [
    "dashboard.view",
    "subscriber.view",
    "subscriber.manage",
    "plan.manage",
    "service.view",
    "service.manage",
    "billing.view",
    "billing.generate",
    "payment.view",
    "payment.create",
    "payment.reverse",
    "gcash.submit",
    "gcash.verify",
    "collection.view",
    "collection.record",
    "collection.reconcile",
    "receivables.view",
    "suspension.manage",
    "report.view",
    "report.export",
    "audit.view"
  ],
  CASHIER: [
    "dashboard.view",
    "subscriber.view",
    "service.view",
    "billing.view",
    "payment.view",
    "payment.create",
    "gcash.submit",
    "receivables.view"
  ],
  COLLECTION_SUPERVISOR: [
    "dashboard.view",
    "subscriber.view",
    "service.view",
    "billing.view",
    "payment.view",
    "collection.view",
    "collection.record",
    "collection.reconcile",
    "receivables.view",
    "report.view",
    "report.export"
  ],
  ACCOUNTANT_AUDITOR: [
    "dashboard.view",
    "subscriber.view",
    "service.view",
    "billing.view",
    "payment.view",
    "payment.reverse",
    "collection.view",
    "collection.reconcile",
    "receivables.view",
    "report.view",
    "report.export",
    "audit.view"
  ],
  TECHNICIAN: [
    "dashboard.view",
    "subscriber.view",
    "service.view",
    "collection.view"
  ],
  READONLY_VIEWER: readOnlyPermissions
};

export const roleDescriptions: Record<RoleCode, string> = {
  OWNER: "Full dashboards, reports, approvals, configuration, users, audit, backup/restore",
  ADMINISTRATOR:
    "Subscribers, plans, service accounts, billing, collections, operational reports",
  CASHIER: "Subscriber search, receive payment, issue receipt, view balances, submit GCash proofs",
  COLLECTION_SUPERVISOR:
    "Collection areas/routes, batches, remittance, reconciliation, collector performance",
  ACCOUNTANT_AUDITOR: "Reports, adjustments/reversals review, receivables, audit trails",
  TECHNICIAN: "Service account and suspension/reconnection operational information only",
  READONLY_VIEWER: "Dashboards and reports without mutation rights"
};

export function permissionsForRole(code: RoleCode): Permission[] {
  return [...rolePermissions[code]];
}
