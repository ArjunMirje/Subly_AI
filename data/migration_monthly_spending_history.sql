-- ============================================================
-- Migration: Create Monthly Spending History Table
-- File: data/migration_monthly_spending_history.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS monthly_spending_history (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "userId" UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INTEGER NOT NULL,
  "totalMonthlySpending" DOUBLE PRECISION NOT NULL,
  "totalYearlyProjection" DOUBLE PRECISION NOT NULL,
  "categoryBreakdown" JSONB NOT NULL,
  "activeSubscriptionCount" INTEGER NOT NULL,
  "couponSavings" DOUBLE PRECISION NOT NULL,
  "autopaySubscriptionCount" INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE("userId", month, year)
);

-- Enable RLS
ALTER TABLE monthly_spending_history ENABLE ROW LEVEL SECURITY;

-- Create Policy
DROP POLICY IF EXISTS "Users can view their own history" ON monthly_spending_history;
CREATE POLICY "Users can view their own history" ON monthly_spending_history FOR ALL USING (auth.uid() = "userId");
