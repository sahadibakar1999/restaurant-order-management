// If the admin page was opened as http://user:pass@host/, browsers refuse
// fetch('/api/...') because the relative URL inherits the credentials.
// Resolving against location.origin (which never contains credentials) fixes it;
// the browser still sends the cached login with each request.
(function () {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string' && input.startsWith('/')) {
      input = location.origin + input;
    }
    return nativeFetch(input, init);
  };
})();
