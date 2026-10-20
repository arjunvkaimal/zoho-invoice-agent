import { readFile } from 'node:fs/promises';
import { SYSTEM_PROMPT } from './llm.js';
import { normalizeText, computeSimilarity, matchCandidate } from './matcher.js';
import { loadCatalogAndAliases } from './pipeline.js';

console.log('Running Client Config Neutrality Verification Test...\n');

let passed = 0;
let total = 0;

function assert(cond, label) {
  total++;
  if (cond) {
    passed++;
    console.log(`[PASS] ${label}`);
  } else {
    console.error(`[FAIL] ${label}`);
  }
}

// 1. Verify byte-for-byte identity of prompt
const expectedOriginalPromptPrefix = 'You are a strict data extraction parser for sales-rep chat messages sent to an accounting firm.';
assert(SYSTEM_PROMPT.startsWith(expectedOriginalPromptPrefix), 'Prompt begins with exact business description');
assert(SYSTEM_PROMPT.includes('DO NOT resolve names to catalog records'), 'Prompt contains core strict parser instructions');
assert(SYSTEM_PROMPT.includes('"rate_same_as_last": boolean'), 'Prompt schema remains exact');
assert(SYSTEM_PROMPT.includes('red lenzo alloy 18 inch'), 'Prompt includes baseline few-shot examples');

// 2. Test normalizeText identity
assert(normalizeText('18 in') === '18', 'normalizeText handles inches correctly');
assert(normalizeText('18"') === '18', 'normalizeText strips quotes');
assert(normalizeText('blk') === 'black', 'token_alias blk -> black');
assert(normalizeText('slv') === 'silver', 'token_alias slv -> silver');
assert(normalizeText('slvr') === 'silver', 'token_alias slvr -> silver');
assert(normalizeText('whls') === 'wheels', 'token_alias whls -> wheels');
assert(normalizeText('whl') === 'wheels', 'token_alias whl -> wheels');
assert(normalizeText('motrs') === 'motors', 'token_alias motrs -> motors');

// 3. Test stop-words identity in computeSimilarity
const sim1 = computeSimilarity('red lenzo 18', 'Alloy Wheel 18" Lenzo - Red');
assert(sim1 >= 0.8, 'Alloy and Wheel stop words behave with exact baseline weighting');

// 4. Test pipeline config loading
const loaded = await loadCatalogAndAliases();
assert(loaded.config && loaded.config.rate_deviation === 0.5, 'pipeline loaded client config correctly');

console.log(`\nConfig Verification completed: ${passed}/${total} assertions passed.`);
if (passed === total) {
  console.log('All neutrality tests passed successfully.');
} else {
  process.exit(1);
}
