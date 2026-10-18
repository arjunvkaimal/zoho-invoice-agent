import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { processMessage, loadCatalogAndAliases } from './pipeline.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse CLI args: --model <name> --split <dev|holdout|all> --delay <ms>
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const MODEL = getArg('--model', process.env.GROQ_MODEL || 'openai/gpt-oss-120b');
const SPLIT = getArg('--split', 'all');
const DELAY_MS = Number(getArg('--delay', 1200));

console.log(`Starting Evaluation Harness:`);
console.log(`- Model: ${MODEL}`);
console.log(`- Target Split: ${SPLIT}`);
console.log(`- Inter-call Delay: ${DELAY_MS}ms\n`);

const { catalog, aliases } = await loadCatalogAndAliases();
const testsetRaw = JSON.parse(await readFile(new URL('../data/testset.json', import.meta.url), 'utf8'));

const testset = SPLIT === 'all'
  ? testsetRaw
  : testsetRaw.filter((t) => t.split === SPLIT);

const rawResults = [];

for (let i = 0; i < testset.length; i++) {
  const item = testset[i];
  const progress = `[${i + 1}/${testset.length}] (${item.split}) ${item.id}: "${item.text.replace(/\n/g, ' ').slice(0, 40)}..."`;
  process.stdout.write(progress);

  const startTime = Date.now();
  try {
    const res = await processMessage(item.text, {
      model: MODEL,
      catalog,
      aliases,
    });
    const totalTime = Date.now() - startTime;

    rawResults.push({
      id: item.id,
      rep: item.rep,
      split: item.split,
      text: item.text,
      expected: item.expected,
      actual: {
        intent: res.parsed.intent,
        action: res.decision.action,
        customer: res.decision.customer?.name || null,
        lines: (res.decision.lines || []).map((l) => ({
          item: l.item?.name || null,
          quantity: l.quantity,
          rate: l.rate,
        })),
        questions: res.decision.questions || [],
        reason: res.decision.reason || null,
      },
      parsed: res.parsed,
      decision: res.decision,
      latency: {
        llmMs: res.meta.latencyMs,
        totalMs: totalTime,
      },
      retries: res.meta.retries,
    });

    console.log(` -> ${res.decision.action.toUpperCase()} (${totalTime}ms)`);
  } catch (err) {
    console.log(` -> ERROR: ${err.message}`);
    rawResults.push({
      id: item.id,
      rep: item.rep,
      split: item.split,
      text: item.text,
      expected: item.expected,
      actual: {
        action: 'error',
        error: err.message,
      },
      latency: { llmMs: 0, totalMs: Date.now() - startTime },
      retries: 0,
    });
  }

  if (i < testset.length - 1 && DELAY_MS > 0) {
    await sleep(DELAY_MS);
  }
}

// Compute comprehensive statistics per split
function calculateMetrics(records) {
  const actions = ['create', 'clarify', 'ignore', 'unsupported'];
  const confusion = {};
  for (const exp of actions) {
    confusion[exp] = {};
    for (const act of actions) confusion[exp][act] = 0;
    confusion[exp]['other'] = 0;
  }

  let correctActionCount = 0;
  let customerExpectedCount = 0;
  let customerMatchCount = 0;

  let totalExpectedLines = 0;
  let correctItemCount = 0;
  let correctQtyCount = 0;
  let correctRateCount = 0;

  let expectedClarifyCount = 0;
  let actualClarifyOnClarifyCount = 0;

  let expectedCreateCount = 0;
  let actualClarifyOnCreateCount = 0;

  let nonInvoiceExpectedCount = 0;
  let nonInvoiceIgnoredCount = 0;
  let nonInvoiceWronglyCreated = 0;

  const confidentlyWrongCases = [];
  const failures = [];

  for (const r of records) {
    const exp = r.expected;
    const act = r.actual;

    // Confusion matrix
    if (confusion[exp.action]) {
      const actAction = actions.includes(act.action) ? act.action : 'other';
      confusion[exp.action][actAction] = (confusion[exp.action][actAction] || 0) + 1;
    }

    const actionMatches = exp.action === act.action;
    if (actionMatches) correctActionCount++;

    // Clarification recall
    if (exp.action === 'clarify') {
      expectedClarifyCount++;
      if (act.action === 'clarify') actualClarifyOnClarifyCount++;
    }

    // Over-asking
    if (exp.action === 'create') {
      expectedCreateCount++;
      if (act.action === 'clarify') actualClarifyOnCreateCount++;
    }

    // Non-invoice handling
    if (exp.action === 'ignore') {
      nonInvoiceExpectedCount++;
      if (act.action === 'ignore') nonInvoiceIgnoredCount++;
      if (act.action === 'create') nonInvoiceWronglyCreated++;
    }

    // Line matching
    if (exp.action === 'create') {
      customerExpectedCount++;
      if (act.customer === exp.customer) customerMatchCount++;

      const expLines = exp.lines || [];
      const actLines = act.lines || [];
      totalExpectedLines += expLines.length;

      for (let idx = 0; idx < expLines.length; idx++) {
        const el = expLines[idx];
        const al = actLines[idx];
        if (al) {
          if (al.item === el.item) correctItemCount++;
          if (al.quantity === el.quantity) correctQtyCount++;
          if (al.rate === el.rate) correctRateCount++;
        }
      }
    }

    // Confidently Wrong Check
    // Agent chose 'create', but ANY field was wrong OR action should not have been create
    if (act.action === 'create') {
      let isWrong = false;
      let wrongReasons = [];

      if (exp.action !== 'create') {
        isWrong = true;
        wrongReasons.push(`Expected action was "${exp.action}", but agent created invoice`);
      } else {
        if (act.customer !== exp.customer) {
          isWrong = true;
          wrongReasons.push(`Customer mismatch: expected "${exp.customer}", got "${act.customer}"`);
        }
        const expLines = exp.lines || [];
        const actLines = act.lines || [];
        if (expLines.length !== actLines.length) {
          isWrong = true;
          wrongReasons.push(`Line count mismatch: expected ${expLines.length}, got ${actLines.length}`);
        } else {
          for (let idx = 0; idx < expLines.length; idx++) {
            const el = expLines[idx];
            const al = actLines[idx];
            if (al.item !== el.item) {
              isWrong = true;
              wrongReasons.push(`Line ${idx + 1} item mismatch: expected "${el.item}", got "${al.item}"`);
            }
            if (al.quantity !== el.quantity) {
              isWrong = true;
              wrongReasons.push(`Line ${idx + 1} qty mismatch: expected ${el.quantity}, got ${al.quantity}`);
            }
            if (al.rate !== el.rate) {
              isWrong = true;
              wrongReasons.push(`Line ${idx + 1} rate mismatch: expected ${el.rate}, got ${al.rate}`);
            }
          }
        }
      }

      if (isWrong) {
        confidentlyWrongCases.push({
          id: r.id,
          text: r.text,
          expected: exp,
          actual: act,
          wrongReasons,
        });
      }
    }

    // Track any general mismatch
    if (!actionMatches || (exp.action === 'create' && act.customer !== exp.customer)) {
      failures.push({
        id: r.id,
        text: r.text,
        expected: exp,
        actual: act,
      });
    }
  }

  // Latencies
  const latencies = records.map((r) => r.latency?.totalMs || 0).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const meanLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const total = records.length;
  return {
    totalMessages: total,
    actionAccuracy: total ? Number(((correctActionCount / total) * 100).toFixed(1)) : 0,
    customerAccuracy: customerExpectedCount ? Number(((customerMatchCount / customerExpectedCount) * 100).toFixed(1)) : 0,
    itemAccuracy: totalExpectedLines ? Number(((correctItemCount / totalExpectedLines) * 100).toFixed(1)) : 0,
    quantityAccuracy: totalExpectedLines ? Number(((correctQtyCount / totalExpectedLines) * 100).toFixed(1)) : 0,
    rateAccuracy: totalExpectedLines ? Number(((correctRateCount / totalExpectedLines) * 100).toFixed(1)) : 0,
    clarificationRecall: expectedClarifyCount ? Number(((actualClarifyOnClarifyCount / expectedClarifyCount) * 100).toFixed(1)) : 0,
    overAskingRate: expectedCreateCount ? Number(((actualClarifyOnCreateCount / expectedCreateCount) * 100).toFixed(1)) : 0,
    confidentlyWrongRate: total ? Number(((confidentlyWrongCases.length / total) * 100).toFixed(1)) : 0,
    confidentlyWrongCount: confidentlyWrongCases.length,
    confidentlyWrongCases,
    nonInvoiceIgnoredRate: nonInvoiceExpectedCount ? Number(((nonInvoiceIgnoredCount / nonInvoiceExpectedCount) * 100).toFixed(1)) : 0,
    nonInvoiceWronglyCreated,
    latency: { mean: meanLatency, p50, p95 },
    confusionMatrix: confusion,
    failures,
  };
}

const devRecords = rawResults.filter((r) => r.split === 'dev');
const holdoutRecords = rawResults.filter((r) => r.split === 'holdout');

const fullReport = {
  model: MODEL,
  timestamp: new Date().toISOString(),
  splits: {
    all: calculateMetrics(rawResults),
    dev: calculateMetrics(devRecords),
    holdout: calculateMetrics(holdoutRecords),
  },
  records: rawResults,
};

// Ensure results dir exists
await mkdir(new URL('../results', import.meta.url), { recursive: true });

const sanitizedModelName = MODEL.replace(/[\/:]/g, '-');
const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
const outFileName = `results/${sanitizedModelName}-${timestampStr}.json`;
const latestFileName = `results/${sanitizedModelName}-latest.json`;

await writeFile(new URL(`../${outFileName}`, import.meta.url), JSON.stringify(fullReport, null, 2), 'utf8');
await writeFile(new URL(`../${latestFileName}`, import.meta.url), JSON.stringify(fullReport, null, 2), 'utf8');

console.log(`\n================ EVALUATION SUMMARY (${MODEL}) ================`);
console.log(`Total: ${rawResults.length} (Dev: ${devRecords.length}, Holdout: ${holdoutRecords.length})`);
console.log(`\n[DEV SPLIT]`);
console.log(`- Action Accuracy:       ${fullReport.splits.dev.actionAccuracy}%`);
console.log(`- Customer Accuracy:     ${fullReport.splits.dev.customerAccuracy}%`);
console.log(`- Item Accuracy:         ${fullReport.splits.dev.itemAccuracy}%`);
console.log(`- Clarification Recall:  ${fullReport.splits.dev.clarificationRecall}%`);
console.log(`- Over-Asking Rate:      ${fullReport.splits.dev.overAskingRate}%`);
console.log(`- CONFIDENTLY WRONG:     ${fullReport.splits.dev.confidentlyWrongRate}% (${fullReport.splits.dev.confidentlyWrongCount} cases)`);
console.log(`- Latency (Mean / p95):  ${fullReport.splits.dev.latency.mean}ms / ${fullReport.splits.dev.latency.p95}ms`);

console.log(`\n[HOLDOUT SPLIT]`);
console.log(`- Action Accuracy:       ${fullReport.splits.holdout.actionAccuracy}%`);
console.log(`- Customer Accuracy:     ${fullReport.splits.holdout.customerAccuracy}%`);
console.log(`- Item Accuracy:         ${fullReport.splits.holdout.itemAccuracy}%`);
console.log(`- Clarification Recall:  ${fullReport.splits.holdout.clarificationRecall}%`);
console.log(`- Over-Asking Rate:      ${fullReport.splits.holdout.overAskingRate}%`);
console.log(`- CONFIDENTLY WRONG:     ${fullReport.splits.holdout.confidentlyWrongRate}% (${fullReport.splits.holdout.confidentlyWrongCount} cases)`);
console.log(`- Latency (Mean / p95):  ${fullReport.splits.holdout.latency.mean}ms / ${fullReport.splits.holdout.latency.p95}ms`);

console.log(`\nSaved full report to ${outFileName} and ${latestFileName}`);
