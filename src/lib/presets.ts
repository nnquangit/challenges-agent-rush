// Demo presets. Shared by UI (buttons) and MockLlm (plans). No server imports.

export interface Preset {
  id: "prove-it" | "csv-analyst" | "research";
  title: string;
  pattern: "A · code" | "B · browser";
  blurb: string;
  message: string;
}

const PROVE_IT_CODE = `# proofbox:fixture=prove-primes
# Claim: the sum of all primes below 100 is 1060.
N = 100
sieve = [True] * N
sieve[0] = sieve[1] = False
for i in range(2, int(N ** 0.5) + 1):
    if sieve[i]:
        for j in range(i * i, N, i):
            sieve[j] = False
primes = [i for i, ok in enumerate(sieve) if ok]
total = sum(primes)
print(f"primes below {N}: {len(primes)}")
print(f"sum: {total}")
assert total == 1060`;

export const SAMPLE_CSV = `date,region,product,units,revenue_usd
2026-10-01,APAC,Sandbox Pro,12,348
2026-10-01,EMEA,Sandbox Pro,7,203
2026-10-02,AMER,Team Plan,4,316
2026-10-02,APAC,Starter,30,270
2026-10-03,EMEA,Team Plan,3,237
2026-10-03,AMER,Sandbox Pro,15,435
2026-10-04,APAC,Team Plan,6,474
2026-10-04,LATAM,Starter,11,99
2026-10-05,AMER,Starter,22,198
2026-10-05,EMEA,Starter,18,162
2026-10-06,LATAM,Sandbox Pro,5,145
2026-10-06,APAC,Sandbox Pro,9,261`;

export const PRESETS: Preset[] = [
  {
    id: "prove-it",
    title: "Prove-It Python",
    pattern: "A · code",
    blurb: "Run a snippet in a sandbox and get a signed receipt: stdout, exit code, sha256 + Ed25519 you can verify.",
    message: `Run this Python and prove the result. Give me a receipt.\n\n\`\`\`python\n${PROVE_IT_CODE}\n\`\`\``,
  },
  {
    id: "csv-analyst",
    title: "CSV Analyst",
    pattern: "A · code",
    blurb: "Agent writes pandas code, hits an error, repairs it, returns a table + chart.",
    message: `Analyze this CSV: total revenue by region, and tell me the top region.\n\n\`\`\`csv\n${SAMPLE_CSV}\n\`\`\``,
  },
  {
    id: "research",
    title: "Research with Receipts",
    pattern: "B · browser",
    blurb: "Sandboxed browser captures evidence; the final submit waits for your OK.",
    message:
      "Open https://shop.example.com/pricing, capture evidence of the Pro plan price, and fill the contact form as a draft. Don't submit without my confirmation.",
  },
];
