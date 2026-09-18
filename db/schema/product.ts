import { relations } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { profiles, workspaces } from './tenancy'

/**
 * The product surface is deliberately thin. Projects exist so that there is
 * something to count against a plan limit, and notes exist so that a project
 * has contents. Billing is the subject of this repository.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    /** Set when a downgrade archives projects above the new plan's limit. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedReason: text('archived_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('projects_workspace_id_idx').on(table.workspaceId)],
)

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Denormalised from the parent project so RLS can scope without a join.
     * Written by a BEFORE trigger, never trusted from the client.
     */
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notes_project_id_idx').on(table.projectId),
    index('notes_workspace_id_idx').on(table.workspaceId),
  ],
)

export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [projects.workspaceId], references: [workspaces.id] }),
  notes: many(notes),
}))

export const notesRelations = relations(notes, ({ one }) => ({
  project: one(projects, { fields: [notes.projectId], references: [projects.id] }),
  workspace: one(workspaces, { fields: [notes.workspaceId], references: [workspaces.id] }),
}))

export type Project = typeof projects.$inferSelect
export type Note = typeof notes.$inferSelect
