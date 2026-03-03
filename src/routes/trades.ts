import { Router, type Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { supabase } from "../config/supabase";

const router = Router();

// GET /trades — recent trades for authenticated user
router.get("/", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;

    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw error;

    return res.json({
      success: true,
      status: "ok",
      message: "Trade history fetched",
      details: data ?? [],
    });
  } catch (err: any) {
    console.error("Fetch trades error:", err?.message || err);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "Failed to fetch trade history",
    });
  }
});

export default router;

