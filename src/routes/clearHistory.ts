import { Router, type Response } from "express";
import { z } from "zod";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { supabase } from "../config/supabase";

const router = Router();

const clearSchema = z.object({
  mode: z.enum(["demo", "real", "all"]),
});

// POST /clear-execution-history
router.post("/", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const { mode } = clearSchema.parse(req.body);
    const userId = req.userId!;

    if (mode === "all") {
      await supabase.from("trades").delete().eq("user_id", userId);
      await supabase.from("webhook_events").delete().eq("user_id", userId);
    } else {
      await supabase.from("trades").delete().eq("user_id", userId).eq("mode", mode);
      await supabase.from("webhook_events").delete().eq("user_id", userId);
    }

    return res.json({
      success: true,
      status: "cleared",
      message: `Execution history cleared for mode: ${mode}`,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ success: false, status: "validation_error", message: err.errors[0].message });
    }
    console.error("Clear history error:", err?.message || err);
    return res.status(500).json({ success: false, status: "error", message: "Failed to clear history" });
  }
});

export default router;
