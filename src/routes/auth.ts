import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { supabase } from "../config/supabase";
import { config } from "../config/env";

const router = Router();

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  username: z.string().min(2).max(50),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /auth/register
router.post("/register", async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const body = registerSchema.parse(req.body);

    // Check existing user
    const { data: existing } = await supabase
      .from("local_users")
      .select("id")
      .eq("email", body.email)
      .single();

    if (existing) {
      return res.status(409).json({ success: false, status: "conflict", message: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(body.password, 12);

    const { data: user, error } = await supabase
      .from("local_users")
      .insert({ email: body.email, password_hash: hashedPassword, username: body.username })
      .select("id, email, username")
      .single();

    if (error || !user) throw error;

    // Create default risk settings for this user
    await supabase
      .from("risk_settings")
      .upsert({
        user_id: user.id,
        size_type: "fixed_usdt",
        size_value: 500,
        max_leverage: 20,
        max_positions: 5,
      });

    // Create default app settings for this user
    const defaultWebhookSecret = crypto.randomBytes(24).toString("hex");
    await supabase
      .from("app_settings")
      .upsert({
        user_id: user.id,
        webhook_secret: defaultWebhookSecret,
        default_exchange: "binance",
        mode: "demo",
      });

    const token = (jwt as any).sign(
      { userId: user.id, email: user.email, username: user.username },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    return res.status(201).json({
      success: true,
      token,
      user: { id: user.id, email: user.email, username: user.username },
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, status: "validation_error", message: err.errors[0].message });
    }
    console.error("Register error:", err?.message || err);
    return res.status(500).json({ success: false, status: "error", message: "Registration failed" });
  }
});

// POST /auth/login
router.post("/login", async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const body = loginSchema.parse(req.body);

    const { data: user, error } = await supabase
      .from("local_users")
      .select("id, email, username, password_hash")
      .eq("email", body.email)
      .single();

    if (error || !user) {
      return res.status(401).json({ success: false, status: "unauthorized", message: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, status: "unauthorized", message: "Invalid credentials" });
    }

    const token = (jwt as any).sign(
      { userId: user.id, email: user.email, username: user.username },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    return res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, username: user.username },
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, status: "validation_error", message: err.errors[0].message });
    }
    console.error("Login error:", err?.message || err);
    return res.status(500).json({ success: false, status: "error", message: "Login failed" });
  }
});

export default router;
