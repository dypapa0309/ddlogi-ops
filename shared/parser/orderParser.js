// shared/parser/orderParser.js
(() => {
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
    if (slashParts.length >= 2) out.time_slot_label = slashParts.slice(1).join(' / ').trim();
    return out;
  }

  function normalizePhone(raw) {
    const m = String(raw || '').match(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/);
    return m ? m[0].replace(/[^0-9]/g, '') : null;
  }

  function detectElevator(lines, prefix) {
    const hit = lines.find((line) => line.startsWith(prefix));
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
        return m ? { name: m[1].trim(), qty: Number(m[2]) } : { name: part, qty: 1 };
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
      if (/(분리필요|분리 필요|분리필|설치필요|설치 필요|철거|주의|유리|대형|무거움|추가작업|추가 작업)/.test(line)) requests.push(line.trim());
    });

    return [...new Set(requests.filter(Boolean))];
  }

  function fmtMoney(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toLocaleString('ko-KR') : '-';
  }

  function parseOrderText(rawText = '') {
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

    return {
      service,
      vehicle,
      move_type,
      move_date,
      time_slot_label,
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
      raw_text: raw,
    };
  }

  function buildAdminPreviewText(parsed = {}) {
    const lines = [];
    lines.push('디디운송 주문서 파싱 미리보기');
    lines.push('');
    if (parsed.service) lines.push(`서비스: ${parsed.service}`);
    if (parsed.vehicle) lines.push(`차량: ${parsed.vehicle}`);
    if (parsed.move_type) lines.push(`이사 방식: ${parsed.move_type}`);
    if (parsed.move_date || parsed.time_slot_label) lines.push(`일정: ${parsed.move_date || '-'} / ${parsed.time_slot_label || '-'}`);
    if (parsed.from_address) lines.push(`출발지: ${parsed.from_address}`);
    if (parsed.to_address) lines.push(`도착지: ${parsed.to_address}`);
    if (parsed.distance_km != null) lines.push(`거리: ${parsed.distance_km}km`);
    if (parsed.from_elevator) lines.push(parsed.from_elevator);
    if (parsed.to_elevator) lines.push(parsed.to_elevator);
    if (parsed.load_text) lines.push(`짐양: ${parsed.load_text}`);
    if (parsed.items_line) lines.push(`가구·가전: ${parsed.items_line}`);
    if (parsed.special_requests?.length) lines.push(`특이사항: ${parsed.special_requests.join(', ')}`);
    if (parsed.helper_scope) lines.push(`인부: ${parsed.helper_scope}`);
    if (parsed.hard_carry_scope) lines.push(`직접 나르기 어려움: ${parsed.hard_carry_scope}`);
    if (parsed.ladder) lines.push(`사다리차: ${parsed.ladder}`);
    if (parsed.cleaning) lines.push(`청소 옵션: ${parsed.cleaning}`);
    if (parsed.disposal) lines.push(`버려주세요: ${parsed.disposal}`);
    if (parsed.customer_phone) lines.push(`전화번호: ${parsed.customer_phone}`);
    if (parsed.quote_amount != null) lines.push(`예상 견적: ₩${fmtMoney(parsed.quote_amount)}`);
    if (parsed.deposit_amount != null) lines.push(`예약금(20%): ₩${fmtMoney(parsed.deposit_amount)}`);
    if (parsed.balance_amount != null) lines.push(`잔금(80%): ₩${fmtMoney(parsed.balance_amount)}`);
    if (parsed.driver_amount != null) lines.push(`기사 운임비: ₩${fmtMoney(parsed.driver_amount)}`);
    return lines.join('\n');
  }

  function buildDriverPreviewText(parsed = {}) {
    const lines = [];
    lines.push('기사 전달 미리보기');
    lines.push('');
    if (parsed.move_date || parsed.time_slot_label) lines.push(`일정: ${parsed.move_date || '-'} / ${parsed.time_slot_label || '-'}`);
    if (parsed.from_address) lines.push(`출발지: ${parsed.from_address}`);
    if (parsed.to_address) lines.push(`도착지: ${parsed.to_address}`);
    if (parsed.distance_km != null) lines.push(`거리: ${parsed.distance_km}km`);
    if (parsed.from_elevator) lines.push(parsed.from_elevator);
    if (parsed.to_elevator) lines.push(parsed.to_elevator);
    if (parsed.load_text) lines.push(`짐양: ${parsed.load_text}`);
    if (parsed.items_line) lines.push(`가구·가전: ${parsed.items_line}`);
    if (parsed.special_requests?.length) lines.push(`특이사항: ${parsed.special_requests.join(', ')}`);
    if (parsed.helper_scope) lines.push(`인부: ${parsed.helper_scope}`);
    if (parsed.hard_carry_scope) lines.push(`직접 나르기 어려움: ${parsed.hard_carry_scope}`);
    if (parsed.ladder) lines.push(`사다리차: ${parsed.ladder}`);
    if (parsed.driver_amount != null) lines.push(`운임비: ₩${fmtMoney(parsed.driver_amount)}`);
    return lines.join('\n');
  }

  window.DDLOGI_ORDER_PARSER = {
    parseOrderText,
    buildAdminPreviewText,
    buildDriverPreviewText,
  };
})();
