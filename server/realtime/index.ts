import type http from "http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { authenticateToken, type AuthUser } from "../auth/middleware";
import { AUTH_COOKIE } from "../auth/cookies";
import { getBoardAccess, resolveDisplayName, serializeBoardState } from "../services/boardAccess";
import { prisma } from "../prisma";
import { boardInclude } from "../services/boardInclude";

interface PresenceMember {
  id: string;
  name: string;
}

function roomName(boardId: string): string {
  return `board:${boardId}`;
}

/** Minimal cookie-header parser (avoids depending on cookie-parser internals). */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

let io: SocketIOServer | null = null;

// Tracks who is currently connected to each board room, for presence.
const presence = new Map<string, Map<string, PresenceMember>>(); // boardId -> socketId -> member

function presenceList(boardId: string) {
  const room = presence.get(boardId);
  if (!room) return [];
  // De-duplicate by user id (same user may have multiple tabs).
  const byUser = new Map<string, { id: string; name: string }>();
  for (const u of room.values()) byUser.set(u.id, { id: u.id, name: u.name });
  return [...byUser.values()];
}

function emitPresence(boardId: string) {
  io?.to(roomName(boardId)).emit("presence", presenceList(boardId));
}

export function initRealtime(
  httpServer: http.Server,
  corsOrigin: string | string[] | boolean,
) {
  io = new SocketIOServer(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
  });

  // Authenticate every socket from the same httpOnly cookie used for REST.
  io.use(async (socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, AUTH_COOKIE);
    const user = await authenticateToken(token);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket: Socket) => {
    const user = socket.data.user as AuthUser;
    let joinedBoardId: string | null = null;

    socket.on("join-board", async (boardId: string) => {
      if (typeof boardId !== "string" || !boardId) return;

      const access = await getBoardAccess(user.id, boardId);
      if (!access) {
        socket.emit("board-error", { message: "You do not have access to this board." });
        return;
      }

      joinedBoardId = boardId;
      socket.join(roomName(boardId));

      let room = presence.get(boardId);
      if (!room) presence.set(boardId, (room = new Map()));
      room.set(socket.id, { id: user.id, name: resolveDisplayName(access, user.name) });

      socket.emit("board-state", serializeBoardState(access.board));
      emitPresence(boardId);
    });

    socket.on("disconnect", () => {
      if (joinedBoardId) {
        const room = presence.get(joinedBoardId);
        room?.delete(socket.id);
        if (room && room.size === 0) presence.delete(joinedBoardId);
        emitPresence(joinedBoardId);
      }
    });
  });

  return io;
}

/**
 * Re-fetch a board and push its current collaborative state to everyone in the
 * room. Called by REST handlers after they mutate a board.
 */
export async function broadcastBoardState(boardId: string): Promise<void> {
  if (!io) return;
  const board = await prisma.board.findUnique({
    where: { id: boardId },
    include: boardInclude,
  });
  if (!board) return;
  io.to(roomName(boardId)).emit("board-state", serializeBoardState(board));
}
