const API_BASE = document
  .querySelector('meta[name="taphoa-api-url"]')
  .content.replace(/\/$/, '');

for (const widget of document.querySelectorAll('[data-waitlist]')) {
  const openButton = widget.querySelector('.wl-btn');
  const form = widget.querySelector('form');
  const input = widget.querySelector('input');
  const submitButton = widget.querySelector('.wl-go');
  const success = widget.querySelector('.wl-done');
  const status = document.getElementById(
    input.getAttribute('aria-describedby'),
  );
  let pending = false;

  const setError = (message, invalid = false) => {
    status.textContent = message;
    input.setAttribute('aria-invalid', String(invalid));
    widget.classList.toggle('has-error', Boolean(message));
  };

  openButton.addEventListener('click', () => {
    widget.classList.add('is-open');
    openButton.hidden = true;
    form.hidden = false;
    input.focus({ preventScroll: true });
  });

  input.addEventListener('input', () => setError(''));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && input.value === '' && !pending) {
      widget.classList.remove('is-open');
      form.hidden = true;
      openButton.hidden = false;
      setError('');
      openButton.focus({ preventScroll: true });
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
    const email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !input.validity.valid) {
      setError('Email chưa đúng, bạn xem lại giúp nhé.', true);
      input.focus({ preventScroll: true });
      return;
    }

    pending = true;
    submitButton.disabled = true;
    form.setAttribute('aria-busy', 'true');
    setError('');
    try {
      const response = await fetch(API_BASE + '/v1/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (response.status === 200) {
        widget.classList.add('is-done');
        form.hidden = true;
        success.hidden = false;
        success.focus({ preventScroll: true });
      } else if (response.status === 422) {
        setError('Email chưa đúng, bạn xem lại giúp nhé.', true);
      } else if (response.status === 429) {
        setError('Bạn gửi hơi nhanh. Bạn thử lại sau ít phút nhé.');
      } else {
        setError('Chưa gửi được email. Bạn thử lại giúp nhé.');
      }
    } catch {
      setError('Chưa kết nối được. Bạn thử lại giúp nhé.');
    } finally {
      pending = false;
      submitButton.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
}

// The board advances every 1,150 ms. Each demo has its own cycle length.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const text = (selector, value) => {
  $(selector).textContent = value;
};
const vnd = (number) => Math.round(number).toLocaleString('vi-VN') + 'đ';
const hints = [
  'Đưa món vào khung',
  'Thấy 3 món',
  '1 món bị che, đang xem thêm',
  '3 món · 60.000đ',
  '3 món · 60.000đ',
  'Đã thêm vào giỏ',
  'Đã thêm vào giỏ',
];
const prompts = [
  'Chạm vào món',
  'Xoay sản phẩm',
  'Xoay tiếp',
  'Đưa ra xa',
  'Lại gần',
  'Lật mặt sau',
  'Nghiêng một chút',
  'Gần xong',
  'Đủ góc rồi',
];
const sales = [
  27000, 37000, 15000, 10000, 64000, 22000, 5000, 48000, 12000, 30000, 19000,
  8000, 41000, 26000, 15000, 9000,
];

function render(tick, reduce = false) {
  const p = reduce ? 5 : tick % 7;
  $('.scr').className =
    'scr p' +
    p +
    Array.from({ length: Math.min(p, 5) }, (_, i) => ' s' + (i + 1)).join('');
  text('[data-scan-hint]', hints[p]);
  text('[data-scan-cta]', p >= 5 ? 'Đã thêm vào giỏ' : 'Thêm vào giỏ');

  const e = reduce ? 11 : tick % 13;
  const fill = Math.min(e, 8);
  $('.ringstage').className =
    'ringstage' +
    (e >= 1 ? ' locked' : '') +
    (e >= 1 && e <= 8 ? ' spin' : '') +
    (e >= 9 ? ' asking' : '') +
    (e >= 11 ? ' isSaved' : '');
  $$('.ring .seg').forEach((sector, index) =>
    sector.classList.toggle('on', index < fill),
  );
  text('[data-frames]', fill * 3);
  text('[data-secs]', (fill * 1.2).toFixed(1).replace('.', ','));
  text('[data-prompt]', prompts[fill]);
  text(
    '[data-said]',
    e >= 10 ? '“Mì Hảo Hảo tôm chua cay năm nghìn”' : 'Đang nghe…',
  );
  $$('.step').forEach((step, i) =>
    step.classList.toggle('on', [e <= 1, e >= 2 && e <= 8, e >= 9][i]),
  );

  const v = reduce ? 8 : tick % 11;
  $('.vcard').classList.toggle('listening', v >= 1 && v <= 4);
  $$('.w').forEach((word, i) =>
    word.classList.toggle('on', i < Math.min(7, v * 2)),
  );
  $$('.vl, .vtotal').forEach((line, i) =>
    line.classList.toggle('on', v >= 5 + i),
  );

  const a = tick % 16;
  const revenue =
    1284000 + sales.slice(0, a).reduce((total, sale) => total + sale, 0);
  text('[data-revenue]', vnd(revenue));
  text('[data-last-sale]', vnd(sales[(a + 15) % 16]));
  text('[data-toast-copy]', 'vừa bán · đơn thứ ' + (46 + a));
  $('.toast').className = 'toast ' + (tick % 2 ? 'ta' : 'tb');
  $('.bar.today div').style.height =
    Math.round((revenue / 2600000) * 100) + '%';
  text('[data-profit]', vnd(revenue * 0.23));
  const counts = [
    42 + Math.floor(a / 2),
    35 + Math.floor(a / 3),
    18 + Math.floor(a / 4),
  ];
  $$('[data-top]').forEach((item, i) => {
    item.textContent = counts[i];
  });
  $$('[data-top-width]').forEach((track, i) => {
    track.style.width = Math.round((counts[i] / 60) * 100) + '%';
  });
}

const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
let timer;
function startDemos() {
  clearInterval(timer);
  let tick = motion.matches ? 5 : 0;
  render(tick, motion.matches);
  if (!motion.matches) timer = setInterval(() => render(++tick), 1150);
}
motion.addEventListener('change', startDemos);
startDemos();
