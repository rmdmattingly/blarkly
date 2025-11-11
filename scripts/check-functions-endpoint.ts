import https from 'node:https';

const ENDPOINT = 'https://us-east4-blarkly-89e82.cloudfunctions.net/joinOrCreateHighLowSession';

const fetchEndpoint = (url: string): Promise<{ status: number; body: string }> => {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
      });
    });

    request.on('error', reject);
    request.end();
  });
};

(async () => {
  try {
    const { status, body } = await fetchEndpoint(ENDPOINT);
    const ok = status === 405 && body.includes('Method Not Allowed');
    console.log(`Endpoint ${ENDPOINT}`);
    console.log(`Status: ${status}`);
    console.log(`Body: ${body}`);
    console.log(`Reachable + rejecting GET as expected: ${ok ? 'yes' : 'no'}`);
    if (!ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Failed to reach Cloud Function', error);
    process.exitCode = 1;
  }
})();
