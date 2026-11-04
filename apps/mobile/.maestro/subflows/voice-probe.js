// Sets output.voice = true when the backend has the voice routes (V1), else false.
// The probe is unauthenticated: a backend with the route answers 400/401/403, one without answers
// 404 (or 405/501). Maestro runs this script on the host (the CLI), so the backend is localhost.
var base =
  typeof API_URL === 'string' && API_URL ? API_URL : 'http://localhost:8080';
var status = 0;
try {
  var response = http.post(base + '/v1/voice/utterances', { body: '' });
  status = Number(response.status || response.statusCode || 0);
} catch (e) {
  status = 0;
}
output.voice =
  status === 400 ||
  status === 401 ||
  status === 403 ||
  status === 415 ||
  status === 422;
console.log(
  'voice probe ' + base + ' -> ' + status + ' enabled=' + output.voice,
);
