import crypto from 'crypto';

function cleanText(raw = '') {
  return String(raw || '').replace(/\r\n?/g, '\n').trim();
}

function linesOf(raw = '') {
  return cleanText(raw)
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
}

function escapeRegExp(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findLabelValue(lines, labels = []) {
  for (const label of labels) {
    const re = new RegExp(`^${escapeRegExp(label)}\\s*[:：]\\s*(.+)$`, 'i');
    const hit = lines.find((line) => re.test(line));
    if (hit) return hit.replace(re, '$1').trim();
  }
  return null;
}

function findLine(lines, patterns = []) {
  for (const pattern of patterns) {
    const hit = lines.find((line) => pattern.test(line));
    if (hit) return hit;
  }
  return null;
}

function parseMoney(value) {
  if (!value) return null;
  const m = String(value).match(/([0-9][0-9,]*)/);
  if (!m) return null;
  const num = Number(String(m[1]).replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function parseDistanceKm(value) {
  if (!value) return null;
  const m = String(value).match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const num = Number(m[1]);
  return Number.isFinite(num) ? num : null;
}

function parseSchedule(value) {
  const out = { move_date: null, time_slot_label: null };
  if (!value) return out;
  const dateMatch = String(value).match(/(20\d{2}-\d{2}-\d{2})/);
  if (dateMatch) out.move_date = dateMatch[1];

  const slashParts = String(value).split('/').map((v) => v.trim()).filter(Boolean);
  if (slashParts.length >= 2) {
    out.time_slot_label = slashParts.slice(1).join(' / ').trim();
  } else {
    const t = String(value).replace(/.*20\d{2}-\d{2}-\d{2}/, '').trim().replace(/^\//, '').trim();
    if (t) out.time_slot_label = t;
  }
  return out;
}

function timeLabelToHHMM(label) {
  const base = '09:00';
  if (!label) return base;
  const t = String(label).trim();
  let m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return `${String(m[1]).padStart(2, '0')}:${m[2]}`;

  m = t.match(/^(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분?)?$/);
  if (m) {
    const ap = m[1] || '';
    let hh = Number(m[2]);
    const mm = Number(m[3] || 0);
    if (ap === '오후' && hh < 12) hh += 12;
    if (ap === '오전' && hh === 12) hh = 0;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  m = t.match(/^(\d{1,2})시$/);
  if (m) return `${String(m[1]).padStart(2, '0')}:00`;
  return base;
}

function buildKstTimestamp(dateStr, timeLabel) {
  if (!dateStr) return null;
  const hhmm = timeLabelToHHMM(timeLabel);
  return `${dateStr}T${hhmm}:00+09:00`;
}

function normalizePhone(raw) {
  const m = String(raw || '').match(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/);
  return m ? m[0].replace(/[^0-9]/g, '') : null;
}

function shortText(text, max = 20) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function detectElevator(lines, prefix) {
  const hit = lines.find((line) => new RegExp(`^${prefix}\\s*엘베`).test(line));
  return hit ? hit.trim() : null;
}

function parseItems(itemsLine) {
  if (!itemsLine) return [];
  return String(itemsLine)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.*?)\s*[x×]\s*(\d+)$/i);
      return m
        ? { name: m[1].trim(), qty: Number(m[2]) }
        : { name: part, qty: 1 };
    });
}

function collectSpecialRequests(lines) {
  const requests = [];
  const direct = findLabelValue(lines, ['가구·가전 기타사항', '기타사항']);
  if (direct) requests.push(direct);

  const knownLabels = [
    '서비스', '차량', '이사 방식', '일정', '출발지', '도착지', '거리', '짐양', '가구·가전',
    '가구·가전 기타사항', '인부', '직접 나르기 어려움', '사다리차', '청소 옵션', '버려주세요',
    '예상 견적', '홈페이지 예상 견적', '문자 상담 3% 추가 할인 적용 견적', '예약금(20%)', '예약금', '잔금(80%)', '잔금', '이름', '연락처', '전화번호'
  ];
  const isKnownLabel = (line) => knownLabels.some((label) => new RegExp(`^${escapeRegExp(label)}\\s*[:：]`).test(line));

  lines.forEach((line) => {
    if (isKnownLabel(line)) return;
    if (/^(출발|도착)\s*엘베/.test(line)) return;
    if (/견적 문의/.test(line)) return;
    if (/^(리드|lead)$/i.test(line)) return;
    if (/^[0-9]{1,2}:[0-9]{2}\s*(AM|PM)$/i.test(line)) return;
    if (/(분리필요|분리 필요|분리필|설치필요|설치 필요|철거|주의|유리|대형|무거움|추가작업|추가 작업)/.test(line)) {
      requests.push(line.trim());
    }
  });

  return [...new Set(requests.filter(Boolean))];
}

export function parseOrderText(rawText = '') {
  const raw = cleanText(rawText);
  const lines = linesOf(raw);

  const service = findLabelValue(lines, ['서비스']);
  const vehicle = findLabelValue(lines, ['차량']);
  const move_type = findLabelValue(lines, ['이사 방식']);
  const scheduleValue = findLabelValue(lines, ['일정']);
  const { move_date, time_slot_label } = parseSchedule(scheduleValue);
  const from_address = findLabelValue(lines, ['출발지']);
  const to_address = findLabelValue(lines, ['도착지']);
  const distance_km = parseDistanceKm(findLabelValue(lines, ['거리']));
  const from_elevator = detectElevator(lines, '출발');
  const to_elevator = detectElevator(lines, '도착');
  const load_text = findLabelValue(lines, ['짐양']);
  const items_line = findLabelValue(lines, ['가구·가전']);
  const helper_scope = findLabelValue(lines, ['인부']);
  const hard_carry_scope = findLabelValue(lines, ['직접 나르기 어려움']);
  const ladder = findLabelValue(lines, ['사다리차']);
  const cleaning = findLabelValue(lines, ['청소 옵션']);
  const disposal = findLabelValue(lines, ['버려주세요']);
  const customer_name = findLabelValue(lines, ['이름', '고객명']);
  const customer_phone = normalizePhone(findLabelValue(lines, ['전화번호', '연락처']) || raw);

  const discountedQuote = parseMoney(findLabelValue(lines, ['문자 상담 3% 추가 할인 적용 견적']));
  const quote_amount = discountedQuote ?? parseMoney(findLabelValue(lines, ['예상 견적', '홈페이지 예상 견적', '예상금액']));
  const deposit_amount = parseMoney(findLabelValue(lines, ['예약금(20%)', '예약금']));
  const balance_amount = parseMoney(findLabelValue(lines, ['잔금(80%)', '잔금']));
  const items = parseItems(items_line);
  const special_requests = collectSpecialRequests(lines);
  const scheduled_at = buildKstTimestamp(move_date, time_slot_label);

  const title = `${shortText(from_address)} → ${shortText(to_address)}`.trim();
  const driver_title = `${shortText(from_address)} → ${shortText(to_address)} / 운임 ${balance_amount ? balance_amount.toLocaleString('ko-KR') + '원' : '-'}`;

  return {
    service,
    vehicle,
    move_type,
    move_date,
    time_slot_label,
    scheduled_at,
    from_address,
    to_address,
    distance_km,
    from_elevator,
    to_elevator,
    load_text,
    items_line,
    items,
    special_requests,
    helper_scope,
    hard_carry_scope,
    ladder,
    cleaning,
    disposal,
    customer_name,
    customer_phone,
    quote_amount,
    deposit_amount,
    balance_amount,
    driver_amount: balance_amount,
    title,
    driver_title,
    raw_text: raw,
  };
}

export function redactOrderForDriver(job = {}) {
  const raw = cleanText(job.raw_text || '');
  const lines = linesOf(raw).filter((line) => {
    return !/^예상 견적\s*[:：]/.test(line)
      && !/^홈페이지 예상 견적\s*[:：]/.test(line)
      && !/^문자 상담 3% 추가 할인 적용 견적\s*[:：]/.test(line)
      && !/^예약금/.test(line)
      && !/^잔금/.test(line)
      && !/^전화번호\s*[:：]/.test(line)
      && !/^연락처\s*[:：]/.test(line);
  });
  if (job.balance_amount != null) lines.push(`운임비: ₩${Number(job.balance_amount).toLocaleString('ko-KR')}`);
  return lines.join('\n');
}

export function sanitizeJobForDriver(job = {}) {
  return {
    ...job,
    customer_name: null,
    customer_phone: null,
    quote_amount: null,
    deposit_amount: null,
    raw_text: redactOrderForDriver(job),
  };
}

export function buildManualJobRow(parsed, { actorUserId } = {}) {
  const nowIso = new Date().toISOString();
  const chat_id = `manual_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  return {
    source: 'manual_paste',
    chat_id,
    chat_id_hash: crypto.createHash('sha256').update(chat_id, 'utf8').digest('hex'),
    source_message_id: null,
    status: 'confirmed',
    status_reason: 'manual_paste_confirmed',
    ops_status: 'open',
    last_message_at: nowIso,
    customer_name: parsed.customer_name || null,
    customer_phone: parsed.customer_phone || null,
    from_address: parsed.from_address || null,
    to_address: parsed.to_address || null,
    move_date: parsed.move_date || null,
    time_slot_label: parsed.time_slot_label || null,
    scheduled_at: parsed.scheduled_at || null,
    quote_amount: parsed.quote_amount ?? null,
    deposit_amount: parsed.deposit_amount ?? null,
    balance_amount: parsed.balance_amount ?? null,
    raw_text: parsed.raw_text || null,
    confirmed_at: nowIso,
  };
}