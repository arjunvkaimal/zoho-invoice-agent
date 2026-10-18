import { readdir, readFile, writeFile } from 'node:fs/promises';

const resultsDir = new URL('../results/', import.meta.url);
const files = (await readdir(resultsDir)).filter((f) => f.endsWith('-latest.json'));

if (files.length === 0) {
  console.log('No *-latest.json files found in results/. Run src/eval.js first.');
  process.exit(1);
}

const reports = [];
for (const file of files) {
  const content = await readFile(new URL(file, resultsDir), 'utf8');
  reports.push(JSON.parse(content));
}

let md = `# Evaluation Report: WhatsApp -> Zoho Books Invoice Agent

**Generated**: ${new Date().toISOString()}  
**Test Suite**: 45 ground-truth messages (32 Dev / 13 Holdout) across 5 sales rep personas  

---

## 1. Executive Summary & Headline Safety Metrics

In an invoice creation workflow, **a confidently wrong invoice is far worse than asking a clarification question**.  
- Creating an incorrect invoice sends wrong billing data to Zoho Books, triggers credit notes or customer disputes, and undermines trust.  
- Asking a clarifying question costs 5 seconds of the rep's time in WhatsApp.

Therefore, our primary safety target is:
$$\\text{Confidently Wrong Rate} \\to 0\\%$$

Below is the side-by-side comparison of the evaluated models across Dev and Holdout splits.

---

## 2. Side-by-Side Model Comparison Table

| Metric | ${reports.map((r) => `${r.model} (Dev)`).join(' | ')} | ${reports.map((r) => `${r.model} (Holdout)`).join(' | ')} |
| :--- | ${reports.map(() => ':---:').join(' | ')} | ${reports.map(() => ':---:').join(' | ')} |
| **Action Accuracy** | ${reports.map((r) => `${r.splits.dev.actionAccuracy}%`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.actionAccuracy}%`).join(' | ')} |
| **Customer Accuracy** | ${reports.map((r) => `${r.splits.dev.customerAccuracy}%`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.customerAccuracy}%`).join(' | ')} |
| **Item Accuracy (per line)** | ${reports.map((r) => `${r.splits.dev.itemAccuracy}%`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.itemAccuracy}%`).join(' | ')} |
| **Quantity Accuracy** | ${reports.map((r) => `${r.splits.dev.quantityAccuracy}%`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.quantityAccuracy}%`).join(' | ')} |
| **Rate Accuracy** | ${reports.map((r) => `${r.splits.dev.rateAccuracy}%`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.rateAccuracy}%`).join(' | ')} |
| **Clarification Recall** | ${reports.map((r) => `${r.splits.dev.clarificationRecall}%`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.clarificationRecall}%`).join(' | ')} |
| **Over-Asking Rate** | ${reports.map((r) => `${r.splits.dev.overAskingRate}%`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.overAskingRate}%`).join(' | ')} |
| **CONFIDENTLY WRONG Rate** 🚨 | ${reports.map((r) => `**${r.splits.dev.confidentlyWrongRate}%** (${r.splits.dev.confidentlyWrongCount})`).join(' | ')} | ${reports.map((r) => `**${r.splits.holdout.confidentlyWrongRate}%** (${r.splits.holdout.confidentlyWrongCount})`).join(' | ')} |
| **Non-Invoice Ignored Rate** | ${reports.map((r) => `${r.splits.dev.nonInvoiceIgnoredRate}%`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.nonInvoiceIgnoredRate}%`).join(' | ')} |
| **Non-Invoice Invoiced** | ${reports.map((r) => `${r.splits.dev.nonInvoiceWronglyCreated}`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.nonInvoiceWronglyCreated}`).join(' | ')} |
| **Latency: Mean** | ${reports.map((r) => `${r.splits.dev.latency.mean}ms`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.latency.mean}ms`).join(' | ')} |
| **Latency: p50** | ${reports.map((r) => `${r.splits.dev.latency.p50}ms`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.latency.p50}ms`).join(' | ')} |
| **Latency: p95** | ${reports.map((r) => `${r.splits.dev.latency.p95}ms`).join(' | ')} | ${reports.map((r) => `${r.splits.holdout.latency.p95}ms`).join(' | ')} |

---

## 3. Confusion Matrices

`;

for (const r of reports) {
  md += `### Model: \`${r.model}\` (All 45 Messages)\n\n`;
  md += `| Expected \\ Actual | Create | Clarify | Ignore | Unsupported | Other |\n`;
  md += `| :--- | :---: | :---: | :---: | :---: | :---: |\n`;
  const m = r.splits.all.confusionMatrix;
  for (const exp of ['create', 'clarify', 'ignore', 'unsupported']) {
    md += `| **${exp}** | ${m[exp].create} | ${m[exp].clarify} | ${m[exp].ignore} | ${m[exp].unsupported} | ${m[exp].other} |\n`;
  }
  md += '\n';
}

md += `---

## 4. Confidently Wrong Cases (Unedited & Transparent)

`;

let hasAnyConfidentlyWrong = false;
for (const r of reports) {
  const wrongCases = r.splits.all.confidentlyWrongCases;
  md += `### Model: \`${r.model}\` (${wrongCases.length} Confidently Wrong Cases)\n\n`;
  if (wrongCases.length === 0) {
    md += `> ✅ **Zero Confidently Wrong Cases!** The agent never created an invoice with incorrect fields or when clarification was warranted.\n\n`;
  } else {
    hasAnyConfidentlyWrong = true;
    for (const c of wrongCases) {
      md += `#### Case \`${c.id}\`\n`;
      md += `- **Input Text**: \`"${c.text.replace(/\n/g, ' ')}"\`\n`;
      md += `- **Expected**: Action \`${c.expected.action}\`, Customer \`${c.expected.customer}\`\n`;
      md += `- **Actual Decision**: Action \`${c.actual.action}\`, Customer \`${c.actual.customer}\`\n`;
      md += `- **Failure Reasons**:\n`;
      for (const re of c.wrongReasons) md += `  - ❌ ${re}\n`;
      md += '\n';
    }
  }
}

md += `---

## 5. Other Action Mismatches & Over-Asking Cases

`;

for (const r of reports) {
  const otherFailures = r.splits.all.failures.filter(
    (f) => !r.splits.all.confidentlyWrongCases.some((cw) => cw.id === f.id)
  );
  md += `### Model: \`${r.model}\` (${otherFailures.length} Other Mismatches)\n\n`;
  if (otherFailures.length === 0) {
    md += `> ✅ **Zero other mismatches.**\n\n`;
  } else {
    for (const f of otherFailures) {
      md += `- **[${f.id}]** \`"${f.text.replace(/\n/g, ' ').slice(0, 60)}..."\`\n`;
      md += `  - Expected: \`${f.expected.action}\` (${f.expected.reason})\n`;
      md += `  - Actual: \`${f.actual.action}\` (Reason: ${f.actual.reason || f.actual.questions?.join('; ') || 'N/A'})\n\n`;
    }
  }
}

await writeFile(new URL('../results/REPORT.md', import.meta.url), md, 'utf8');
console.log('✅ Generated results/REPORT.md successfully!');
