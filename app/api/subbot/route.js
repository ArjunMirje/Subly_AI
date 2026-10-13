import { NextResponse } from 'next/server';
import { createClientServer } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/auth';
import { checkAndGenerateMonthlySnapshotsForUser } from '@/lib/cron';

export async function POST(request) {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { message, history, comparisonPeriod, generateReportInsights } = body;

    const supabase = await createClientServer();

    // 1. Auto-generate snapshots for the current user to ensure context is up-to-date
    await checkAndGenerateMonthlySnapshotsForUser(user.id, supabase);

    // 2. Fetch user's subscriptions and coupons
    const { data: subscriptions = [] } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('userId', user.id);

    const { data: coupons = [] } = await supabase
      .from('coupons')
      .select('*')
      .eq('userId', user.id);

    // 3. Fetch user's historical monthly spending snapshots
    let monthlyHistory = [];
    try {
      const { data: hist, error: histError } = await supabase
        .from('monthly_spending_history')
        .select('*')
        .eq('userId', user.id)
        .order('year', { ascending: false })
        .order('month', { ascending: false })
        .limit(12);

      if (!histError) {
        monthlyHistory = hist || [];
      }
    } catch (e) {
      console.warn("Could not read monthly_spending_history:", e.message);
    }

    const todayStr = new Date().toISOString().split('T')[0];

    // Calculate current monthly spending context
    const activeSubs = (subscriptions || []).filter(s => s.status !== 'expired' || s.autopayEnabled);
    const currentMonthlySpend = activeSubs.reduce((acc, sub) => {
      let monthly = sub.cost;
      if (sub.billingCycle === 'yearly') monthly = sub.cost / 12;
      else if (sub.billingCycle === 'half-yearly') monthly = sub.cost / 6;
      return acc + monthly;
    }, 0);

    // Calculate current month statistics
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const currentCategoryBreakdown = {};
    activeSubs.forEach(sub => {
      let monthly = sub.cost;
      if (sub.billingCycle === 'yearly') monthly = sub.cost / 12;
      else if (sub.billingCycle === 'half-yearly') monthly = sub.cost / 6;
      currentCategoryBreakdown[sub.category] = (currentCategoryBreakdown[sub.category] || 0) + monthly;
    });

    const currentCouponSavings = activeSubs.reduce((acc, sub) => {
      if (!sub.couponCode || !sub.couponDiscount) return acc;
      let monthlyDiscount = 0;
      const discountStr = sub.couponDiscount.toString().replace(/off/i, '').trim();
      if (discountStr.endsWith('%')) {
        const pct = parseFloat(discountStr);
        if (!isNaN(pct)) {
          monthlyDiscount = sub.cost * (pct / 100);
        }
      } else {
        const flat = parseFloat(discountStr.replace(/[₹$£€Rs,\s]/gi, ''));
        if (!isNaN(flat)) {
          monthlyDiscount = flat;
        }
      }
      if (sub.billingCycle === 'yearly') monthlyDiscount = monthlyDiscount / 12;
      else if (sub.billingCycle === 'half-yearly') monthlyDiscount = monthlyDiscount / 6;
      return acc + monthlyDiscount;
    }, 0);

    const currentAutopayCount = activeSubs.filter(sub => sub.autopayEnabled).length;

    // Use Groq API
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return NextResponse.json({ error: 'Groq API Key not configured' }, { status: 500 });
    }

    if (generateReportInsights) {
      // Prompt for PDF Report Insights using historical monthly snapshots
      const systemPrompt = `You are a professional financial advisor specializing in digital subscription management for Subly.
Your task is to write a concise, professional "AI Financial Insights" summary (150-250 words) for the user's monthly subscription report.
Base your insights strictly on the user's current subscription state and their historical monthly snapshots.

Here is the data:
- Today's Date: ${todayStr}
- Current Month Statistics:
  * Total Monthly Spend: ₹${currentMonthlySpend.toFixed(2)}
  * Total Yearly Projection: ₹${(currentMonthlySpend * 12).toFixed(2)}
  * Category Breakdown: ${JSON.stringify(currentCategoryBreakdown)}
  * Active Subscriptions: ${JSON.stringify(activeSubs.map(s => ({ name: s.name, category: s.category, cost: s.cost, billingCycle: s.billingCycle, renewalDate: s.renewalDate, autopayEnabled: s.autopayEnabled })))}
  * Coupon Savings: ₹${currentCouponSavings.toFixed(2)}
  * Autopay Subscriptions Count: ${currentAutopayCount}
- Available Coupons in Vault: ${JSON.stringify(coupons.map(c => ({ code: c.code, discount: c.discount, expiryDate: c.expiryDate, service: c.service })))}
- Historical Monthly Spending Snapshots (Last 12 Months): ${JSON.stringify(monthlyHistory)}

The summary should cover:
1. Overall spending overview and comparison with actual historical monthly spending records. Compare with the previous month if available, or the average of past snapshots.
2. Highlight which categories increased or decreased.
3. Coupon savings, renewal dates, and autopay findings.
4. Actionable, personalized recommendations for reducing future expenses.

Style Guidelines:
- Write in a professional, polite, and encouraging tone.
- Do not use markdown headers, lists, or bullets. Write in 2-3 standard paragraphs.
- Use Rupees (₹) when referencing amounts.
- Do not output any HTML tags or JSON structures. Return only the raw plain text.`;

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqApiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Please generate the subscription financial insights for my report comparing against actual database history.` }
          ],
          temperature: 0.7
        })
      });

      if (!response.ok) {
        throw new Error(`Groq API returned status ${response.status}`);
      }

      const resData = await response.json();
      const text = resData.choices?.[0]?.message?.content || '';
      return NextResponse.json({ summary: text });
    }

    // Default chat behavior
    // Prepare prompt
    const systemPrompt = `You are SubBot, the digital subscription assistant and AI Smart Subscription Coach for Subly.
You help users manage their subscriptions and coupons using natural language and create interactive savings plans.
You are professional, friendly, and speak with high intelligence.

Today's Date: ${todayStr}
User's Current Subscriptions: ${JSON.stringify(subscriptions)}
User's Current Coupons: ${JSON.stringify(coupons)}
Current Month (${currentMonth}/${currentYear}) Spend: ₹${currentMonthlySpend.toFixed(2)}
Historical Monthly Snapshots (Stored History, up to 12 months): ${JSON.stringify(monthlyHistory)}

You MUST always return a JSON object with the following structure:
{
  "reply": "Your conversational reply in Markdown format. Explain what action is being taken, answer the user's question, or explain options.",
  "action": {
    "type": "add_subscription" | "edit_subscription" | "delete_subscription" | "add_coupon" | "edit_coupon" | "delete_coupon" | "apply_best_coupon" | "explain_analytics" | "savings_suggestions" | null,
    "data": { ... }
  } or null,
  "options": [string, string, ...] or null,
  "coachReport": {
    "goal": "Stay under ₹2,000/month" (or user's selected budget/goal description),
    "currentSpending": number (current monthly cost sum, e.g. 2648),
    "projectedSpending": number (optimized monthly cost sum, e.g. 1964),
    "estimatedMonthlySaving": number (monthly saving amount, e.g. 684),
    "estimatedYearlySaving": number (yearly saving amount, e.g. 8208),
    "recommendations": [
      {
        "type": "apply_best_coupon" | "edit_subscription" | "delete_subscription",
        "title": "Apply SAVE50 coupon" (or similar short actionable title like "Disable Autopay" or "Consider Cancelling"),
        "targetName": "Netflix" (the subscription service name),
        "saving": "₹325/month" (or similar saving text),
        "reason": "Coupon expires before renewal." (or other custom reason explanation),
        "confidence": "High" | "Medium" | "Low",
        "actionData": {
          // For apply_best_coupon:
          "subscriptionId": number,
          "couponId": number,
          "couponCode": "SAVE50",
          "couponDiscount": "₹325"
          // For edit_subscription (e.g. disabling autopay):
          "id": number,
          "name": "Netflix",
          "cost": 649,
          "category": "Entertainment",
          "billingCycle": "monthly",
          "renewalDate": "2026-08-01",
          "autopayEnabled": false
          // For delete_subscription:
          "id": number,
          "name": "Netflix"
        }
      }
    ]
  } or null
}

Guidelines for AI Smart Subscription Coach & Interactive Flows:
1. When the user asks to start the coach/planning flow ("Let's start the AI Subscription Coach planning session" or "Start Planning"), guide them interactive step-by-step:
   * First, ask: "What is your goal?"
   * Provide options: ["Save money", "Stay under a monthly budget", "Reduce yearly expenses", "Optimize subscriptions", "Something else"]
2. If they select "Stay under a monthly budget" (or write a query about staying under a budget), reply:
   * "What monthly budget would you like to stay under?"
   * Do NOT output options or a report yet. Simply wait for the number.
3. Once they specify a budget (e.g. "2000" or "₹2000"), or if they select "Save money" / "Optimize subscriptions" directly, perform a deep financial analysis on their subscriptions and coupon list to formulate an optimization report:
   * Match unused coupons from their vault to active subscriptions to calculate savings (e.g. apply_best_coupon).
   * Identify expensive services with autopay enabled where they might want to disable autopay (edit_subscription to disable autopay).
   * Look for content overlaps (e.g. having both Netflix and Disney+ in "Entertainment") and suggest cancelling the least valuable (delete_subscription).
   * Fill out the "coachReport" object with these details, explaining the precise "reason" and "saving" for each.
4. Keep the conversation natural. The LLM handles prompting options and returning the structured coachReport object.

Guidelines for action types in default chat:
- If a normal action (like add_subscription) is triggered, return it under "action" exactly as before. If required fields are missing, prompt for only the missing ones using the form layout from before.

Guidelines for Analytics Comparison & History:
- When the user asks to compare spending, use the ACTUAL historical snapshots in the 'Historical Monthly Snapshots' array. Do not estimate. If there are fewer than 12 snapshots available, compare against all available ones. If the user requests a period longer than the stored history, explain politely that only up to 12 months are available.`;

    const messages = [];
    if (history && Array.isArray(history)) {
      history.forEach(m => {
        messages.push({ role: m.role, content: m.content });
      });
    }
    messages.push({ role: 'user', content: message });

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        response_format: { type: "json_object" },
        temperature: 0.2
      })
    });

    if (!response.ok) {
      throw new Error(`Groq API returned status ${response.status}`);
    }

    const resData = await response.json();
    
    let replyJson;
    try {
      replyJson = JSON.parse(resData.choices?.[0]?.message?.content || '{}');
    } catch (e) {
      console.error("Failed to parse JSON content from Groq:", resData.choices?.[0]?.message?.content);
      replyJson = {
        reply: resData.choices?.[0]?.message?.content || 'Sorry, I encountered an issue processing that request.',
        action: null,
        options: null,
        coachReport: null
      };
    }

    return NextResponse.json(replyJson);
  } catch (error) {
    console.error("POST /api/subbot error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
