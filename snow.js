// light falling-snow background, pauses off-screen and respects reduced motion
(function () {
  var canvas = document.getElementById("snow");
  if (!canvas) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var ctx = canvas.getContext("2d");
  var flakes = [];
  var count = 70;
  var w, h;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resize);
  resize();

  function makeFlake() {
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 2.2 + 0.6,
      speed: Math.random() * 0.6 + 0.25,
      drift: Math.random() * 0.6 - 0.3,
      sway: Math.random() * Math.PI * 2,
      opacity: Math.random() * 0.5 + 0.35,
    };
  }
  for (var i = 0; i < count; i++) flakes.push(makeFlake());

  var running = true;
  document.addEventListener("visibilitychange", function () {
    running = !document.hidden;
    if (running) requestAnimationFrame(tick);
  });

  function tick() {
    if (!running) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (var i = 0; i < flakes.length; i++) {
      var f = flakes[i];
      f.sway += 0.01;
      f.y += f.speed;
      f.x += f.drift + Math.sin(f.sway) * 0.2;
      if (f.y > h + 4) { f.y = -4; f.x = Math.random() * w; }
      if (f.x > w + 4) f.x = -4;
      if (f.x < -4) f.x = w + 4;
      ctx.globalAlpha = f.opacity;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
