// Sets output.assistant = true when the backend has the assistant routes (X3), else false.
// The probe is unauthenticated: a backend with the routes answers 401, one without answers 404
// (or 405/501). Maestro runs this script on the host (the CLI), so the backend is localhost.
var base =
  typeof API_URL === 'string' && API_URL ? API_URL : 'http://localhost:8080';
var status = 0;
try {
  var response = http.get(base + '/v1/assistant/threads');
  status = Number(response.status || response.statusCode || 0);
} catch (e) {
  status = 0;
}
output.assistant = status === 401 || status === 403 || status === 200;
console.log(
  'assistant probe ' + base + ' -> ' + status + ' enabled=' + output.assistant,
);
