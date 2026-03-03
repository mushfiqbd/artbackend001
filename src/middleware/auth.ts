import { Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/env";

export interface AuthRequest extends Request {
  userId?: string;
}

export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction): Response | void => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, status: "unauthorized", message: "Missing or invalid token" });
  }

  try {
    const decoded = jwt.verify(header.split(" ")[1], config.jwtSecret) as { userId: string };
    req.userId = decoded.userId;
    return next();
  } catch {
    return res.status(401).json({ success: false, status: "unauthorized", message: "Invalid or expired token" });
  }
};
