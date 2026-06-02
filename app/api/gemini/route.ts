const MODEL = 'gemini-2.0-flash';

const SYSTEM_PROMPT = `You are a sales-ops analyst at VXI Global Solutions, a BPO that sells outsourced customer experience and contact center services. Buyers own or influence decisions about customer support, customer experience, contact centers, vendor management, or operations.

For each contact, output exactly two lines and nothing else:
DECISION: KEEP | DROP | REVIEW
REASON: <one short phrase under 12 words>

KEEP if all true:
1. Seniority is Director, VP, SVP, EVP, C-level, Chief, Head of, or President
2. Title or function shows ownership of CX, customer care, customer service, customer support, contact center, call center, support operations, CX strategy, vendor management, BPO procurement, or operations leadership with CX in scope
3. Company is a real operating company (not staffing/recruiting/BPO competitor)

DROP if any true:
- Seniority is Manager, Senior Manager, Lead, Analyst, Coordinator, Specialist, IC, or unspecified
- Function is engineering, software, IT, data science, security, product, design, marketing (unless CX-marketing), sales (unless CX-sales), legal, HR, unrelated finance, R&D, or clinical
- Company is a BPO competitor: Teleperformance, Concentrix, TTEC, Alorica, Sitel, Foundever, Sutherland, Conduent, Genpact, iQor, Webhelp, Majorel, ResultsCX
- Company is a recruiting/staffing/consultancy

REVIEW if:
- Title is Director/VP of Procurement or Vendor Management
- Title is vague (Director of Operations with no clarifier)
- Title and function fields conflict
- Seniority is high but role fit ambiguous

Tie-breaker: when in doubt, DROP.`;

export async function POST(req: Request) {
  const { contactText } = await req.json();

  const geminiRes = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GEMINI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 80,
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Contact:\n${contactText}\n\nDecide:` },
        ],
      }),
    }
  );

  if (!geminiRes.ok) {
    const status = geminiRes.status;
    const body = await geminiRes.text().catch(() => '');
    const retryAfter = geminiRes.headers.get('retry-after') ?? geminiRes.headers.get('x-ratelimit-reset-requests');
    return Response.json({ error: `Gemini ${status}: ${body.slice(0, 300)}`, status, retryAfter }, { status });
  }

  const data = await geminiRes.json();
  return Response.json(data);
}
