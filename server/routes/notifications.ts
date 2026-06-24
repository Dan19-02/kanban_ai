import { Router } from "express";
import { prisma } from "../prisma";
import { asyncHandler } from "../lib/http";
import { requireAuth } from "../auth/middleware";
import { serializeNotification } from "../services/notifications";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.notification.count({ where: { userId, read: false } }),
    ]);
    res.json({ notifications: items.map(serializeNotification), unread });
  }),
);

notificationsRouter.post(
  "/read",
  asyncHandler(async (req, res) => {
    await prisma.notification.updateMany({
      where: { userId: req.user!.id, read: false },
      data: { read: true },
    });
    res.json({ ok: true });
  }),
);
