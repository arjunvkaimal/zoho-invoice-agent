import { matchCandidate, deriveGenericTokens, computeSimilarity } from './matcher.js';
import { decide } from './pipeline.js';

console.log('Running Multi-Domain Generalization Test Suite...\n');

let passed = 0;
let total = 0;

function assert(condition, label) {
  total++;
  if (condition) {
    passed++;
    console.log(`[PASS] ${label}`);
  } else {
    console.error(`[FAIL] ${label}`);
  }
}

// ==========================================
// Domain 1: Pharmaceuticals
// ==========================================
console.log('--- Domain 1: Pharmaceuticals (Healthcare Wholesale) ---');
const pharmaCatalog = {
  customers: [
    { contact_id: 'ph-c1', name: 'Apollo Pharmacy Central' },
    { contact_id: 'ph-c2', name: 'MedPlus Healthcare Hub' },
    { contact_id: 'ph-c3', name: 'Care & Cure Medicals' },
  ],
  items: [
    { item_id: 'ph-i1', name: 'Dolo 650mg Paracetamol Tablet', rate: 32 },
    { item_id: 'ph-i2', name: 'Dolo 500mg Paracetamol Tablet', rate: 28 },
    { item_id: 'ph-i3', name: 'Azithral 500mg Strip of 5', rate: 115 },
    { item_id: 'ph-i4', name: 'Cough Syrup 100ml Bottle', rate: 85 },
    { item_id: 'ph-i5', name: 'Augmentin 625 Duo Tablet', rate: 190 },
  ],
};

// 1.1 Test dynamic filler tokens derivation for pharma
const pharmaGenerics = deriveGenericTokens(pharmaCatalog.items, 0.3);
assert(pharmaGenerics.has('tablet'), 'Dynamic filler token detected "tablet" in pharma catalog');
assert(!pharmaGenerics.has('650mg') && !pharmaGenerics.has('650'), 'Preserved critical dosages/dimensions as non-generic');

// 1.2 Matching test: Dosage preservation (650 vs 500)
// Real pipeline LLM extracts clean item_text: 'dolo 650' (quantity 10 separated)
const dolo650Match = matchCandidate('dolo 650', pharmaCatalog.items, { genericWords: pharmaGenerics });
assert(dolo650Match.status === 'matched' && dolo650Match.match.item_id === 'ph-i1', 'Matched Dolo 650 without confusing with Dolo 500');

const dolo500Match = matchCandidate('dolo 500', pharmaCatalog.items, { genericWords: pharmaGenerics });
assert(dolo500Match.status === 'matched' && dolo500Match.match.item_id === 'ph-i2', 'Matched Dolo 500 cleanly');

// 1.3 Decision engine test in pharma
const pharmaDecision = decide(
  {
    intent: 'create_invoice',
    customer_text: 'Apollo',
    lines: [
      { item_text: 'augmentin 625', quantity: 20, rate: 190 },
      { item_text: 'azithral 500', quantity: 15, rate: 115 },
    ],
  },
  pharmaCatalog
);
assert(pharmaDecision.action === 'create', 'Pharma order raised valid draft decision');
assert(pharmaDecision.customer.name === 'Apollo Pharmacy Central', 'Customer resolved correctly to Apollo');
assert(pharmaDecision.lines.length === 2, 'Resolved 2 line items for pharma order');

// ==========================================
// Domain 2: Construction & Building Materials
// ==========================================
console.log('\n--- Domain 2: Construction & Building Materials ---');
const constructionCatalog = {
  customers: [
    { contact_id: 'con-c1', name: 'BuildWell Infrastructure Ltd' },
    { contact_id: 'con-c2', name: 'Shree Balaji Hardware & Cement' },
    { contact_id: 'con-c3', name: 'Apex Builders' },
  ],
  items: [
    { item_id: 'con-i1', name: 'UltraTech Cement 50kg Bag', rate: 380 },
    { item_id: 'con-i2', name: 'ACC Cement 50kg Bag', rate: 375 },
    { item_id: 'con-i3', name: 'Tata Tiscon 12mm TMT Steel Rebar', rate: 64000 },
    { item_id: 'con-i4', name: 'Tata Tiscon 16mm TMT Steel Rebar', rate: 63500 },
    { item_id: 'con-i5', name: 'River Sand Coarse 1 Unit Brass', rate: 7500 },
  ],
};

const conGenerics = deriveGenericTokens(constructionCatalog.items, 0.3);
assert(conGenerics.has('cement'), 'Dynamic filler token detected "cement" across construction catalog');

// 2.1 Rebar mm dimension protection
const rebar12Match = matchCandidate('tata tiscon 12mm', constructionCatalog.items, { genericWords: conGenerics });
assert(rebar12Match.status === 'matched' && rebar12Match.match.item_id === 'con-i3', 'Matched 12mm rebar without cross-matching 16mm');

// In real pipeline, LLM extracts 'tiscon 16mm' as item_text and '2 tons' as quantity
const rebar16Match = matchCandidate('tiscon 16mm', constructionCatalog.items, { genericWords: conGenerics });
assert(rebar16Match.status === 'matched' && rebar16Match.match.item_id === 'con-i4', 'Matched 16mm rebar cleanly');

// 2.2 Vague query in construction triggers clarification
const vagueCement = matchCandidate('cement 50kg', constructionCatalog.items, { genericWords: conGenerics });
assert(vagueCement.status === 'ambiguous', 'Vague "cement 50kg" correctly flagged as ambiguous between UltraTech and ACC');

// ==========================================
// Domain 3: Regression Test on Existing Automotive Catalogue
// ==========================================
console.log('\n--- Domain 3: Regression on Automotive Catalogue ---');
const autoCatalog = {
  customers: [
    { contact_id: '4333761000000056001', name: 'VK Enterprises' },
    { contact_id: '4333761000000053010', name: 'Sharma Motors' },
    { contact_id: '4333761000000050010', name: 'Sharma Tyres' },
  ],
  items: [
    { item_id: '1', name: 'Alloy Wheel 17" Lenzo - Red', rate: 4900 },
    { item_id: '2', name: 'Alloy Wheel 18" Lenzo - Red', rate: 5400 },
    { item_id: '3', name: 'Tyre 205/55R16', rate: 4200 },
  ],
};

const autoDecision = decide(
  {
    intent: 'create_invoice',
    customer_text: 'VK',
    lines: [{ item_text: 'red lenzo alloy 18 inch', quantity: 4, rate: 5200 }],
  },
  autoCatalog,
  { customers: { vk: 'VK Enterprises' } }
);
assert(autoDecision.action === 'create', 'Automotive order created draft');
assert(autoDecision.lines[0].item.name === 'Alloy Wheel 18" Lenzo - Red', 'Automotive item matched exact 18" red alloy');

console.log(`\nMulti-Domain Test Suite completed: ${passed}/${total} assertions passed.`);
if (passed === total) {
  console.log('All multi-domain tests passed successfully.');
} else {
  process.exit(1);
}
