(function() {
    var API = 'https://wca-news-api.zeabur.app/api';
    var form = document.querySelector('.newsletter-form');
    if (!form) return;
    var input = form.querySelector('input[type="email"]');
    var btn = form.querySelector('button[type="submit"]');
    form.onsubmit = function(e) {
          e.preventDefault();
          var email = input.value;
          if (!email) return;
          btn.disabled = true;
          btn.textContent = '\u8655\u7406\u4e2d...';
          fetch(API + '/subscribe', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email: email })
          })
          .then(function(r) { return r.json(); })
          .then(function(data) {
                  if (data.success) {
                            btn.textContent = '\u2714 \u5df2\u8a02\u95b1';
                            btn.style.background = '#2D7D46';
                            input.value = '';
                  } else {
                            btn.textContent = data.message || '\u8a02\u95b1\u5931\u6557';
                            setTimeout(function() { btn.textContent = '\u7acb\u5373\u8a02\u95b1'; btn.disabled = false; }, 3000);
                  }
          })
          .catch(function() {
                  btn.textContent = '\u7db2\u8def\u932f\u8aa4';
                  setTimeout(function() { btn.textContent = '\u7acb\u5373\u8a02\u95b1'; btn.disabled = false; }, 3000);
          });
    };
})();
