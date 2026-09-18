import { relations } from 'drizzle-orm'
import { boolean, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

import { workspaceRole } from './enums'

/** Public projection of `auth.users`. Application code reads this, never auth. */
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  fullName: text('full_name'),
  avatarUrl: text('avatar_url'),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The billing boundary. A subscription belongs to a workspace, never to a
 * user, so one person can sit on a Free workspace and a Business one at once.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [index('workspaces_owner_id_idx').on(table.ownerId)],
)

/** One row per seat. Seat-billed plans push `count(*)` to Stripe as quantity. */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull().default('member'),
    invitedBy: uuid('invited_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('workspace_members_workspace_id_user_id_key').on(table.workspaceId, table.userId),
    index('workspace_members_user_id_idx').on(table.userId),
    index('workspace_members_workspace_id_idx').on(table.workspaceId),
  ],
)

export const profilesRelations = relations(profiles, ({ many }) => ({
  ownedWorkspaces: many(workspaces),
  memberships: many(workspaceMembers),
}))

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(profiles, { fields: [workspaces.ownerId], references: [profiles.id] }),
  members: many(workspaceMembers),
}))

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(profiles, { fields: [workspaceMembers.userId], references: [profiles.id] }),
}))

export type Profile = typeof profiles.$inferSelect
export type Workspace = typeof workspaces.$inferSelect
export type WorkspaceMember = typeof workspaceMembers.$inferSelect
