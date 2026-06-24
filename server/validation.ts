import { z } from "zod";

// --- Auth ---

export const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("A valid email is required").max(254),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200, "Password is too long"),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required"),
  password: z.string().min(1, "Password is required"),
});

// --- Projects ---

// Fixed colour allow-list. We never store raw CSS — the frontend maps each
// token to a Tailwind class, so an attacker can't inject styles via the value.
export const PROJECT_COLORS = [
  "indigo",
  "emerald",
  "amber",
  "rose",
  "sky",
  "violet",
  "teal",
  "slate",
] as const;

const projectColor = z.enum(PROJECT_COLORS);

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Project name is required").max(120),
  description: z.string().trim().max(500, "Description is too long").optional(),
  color: projectColor.default("indigo"),
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1, "Project name is required").max(120),
    description: z.string().trim().max(500, "Description is too long").nullable(),
    color: projectColor,
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "No fields to update");

// --- Boards ---

export const createBoardSchema = z.object({
  name: z.string().trim().min(1, "Board name is required").max(120),
  // Optional owning project. Verified against ownership in the route handler.
  projectId: z.string().trim().min(1).max(40).optional(),
});

export const updateBoardSchema = z.object({
  name: z.string().trim().min(1, "Board name is required").max(120),
});

export const analyzeSchema = z.object({
  transcript: z
    .string()
    .trim()
    .min(1, "Transcript is required")
    .max(100_000, "Transcript is too long (max 100k characters)"),
});

export const shareSchema = z.object({
  role: z.enum(["EDITOR", "VIEWER"]).default("EDITOR"),
});

export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required"),
  role: z.enum(["EDITOR", "VIEWER"]).default("EDITOR"),
});

export const displayNameSchema = z.object({
  displayName: z.string().trim().min(1, "Please enter a name").max(60, "That name is too long"),
});

export const joinSchema = z.object({
  token: z.string().min(1, "A share token is required"),
});

// --- Action items ---

const priority = z.enum(["High", "Medium", "Low"]);

export const createActionItemSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(300),
  assignee: z.string().trim().min(1).max(120).default("Unassigned"),
  description: z.string().max(5000).optional(),
  priority: priority.optional(),
  dueDate: z.string().max(40).optional(),
});

export const updateActionItemSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    assignee: z.string().trim().min(1).max(120),
    description: z.string().max(5000).nullable(),
    status: z.enum(["pending", "completed"]),
    priority: priority.nullable(),
    dueDate: z.string().max(40).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "No fields to update");

// --- Comments ---

export const createCommentSchema = z.object({
  text: z.string().trim().min(1, "Comment cannot be empty").max(2000),
});

// --- Billing ---

export const checkoutSchema = z.object({
  plan: z.enum(["STARTER", "PRO", "UNLIMITED"]),
});
