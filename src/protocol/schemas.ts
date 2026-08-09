import { z } from "zod";

export const providerSchema = z.enum(["claude-code", "codex", "cli", "unknown"]);

export const repositorySchema = z.object({
  identity: z.string().min(1).max(2048),
  name: z.string().min(1).max(256),
  root: z.string().min(1).max(4096),
  branch: z.string().min(1).max(512),
});

export const sessionSchema = z.object({
  id: z.uuid(),
  provider: providerSchema,
  providerSessionId: z.string().max(512).optional(),
  repository: repositorySchema,
  taskLabel: z.string().max(512).optional(),
  pid: z.number().int().positive().optional(),
});

export const heartbeatSchema = z.object({
  taskLabel: z.string().max(512).optional(),
});

export const sendMessageSchema = z.object({
  senderSessionId: z.uuid().optional(),
  to: z.string().min(1).max(1024),
  body: z.string().min(1).max(32 * 1024),
  threadId: z.uuid().optional(),
  idempotencyKey: z.uuid().optional(),
});

export const leaseSchema = z.object({
  sessionId: z.uuid(),
  paths: z.array(z.string().min(1).max(2048)).min(1).max(100),
  ttlMinutes: z.number().int().min(1).max(1440),
  note: z.string().max(2048).optional(),
});
