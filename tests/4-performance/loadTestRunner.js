/**
 * High-performance concurrent load testing engine for Ugbekun 2.0
 */
async function executeLoadTest({ name, url, method = 'GET', headers = {}, body = null, totalRequests = 100, concurrency = 20 }) {
  console.log(`\n🚀 [LOAD TEST] ${name}`);
  console.log(`Target: ${method} ${url}`);
  console.log(`Load: ${totalRequests} total requests | Concurrency: ${concurrency} parallel workers`);

  const latencies = [];
  let successful = 0;
  let failed = 0;
  const startTime = Date.now();

  const stringBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

  async function worker(requestsToRun) {
    for (let i = 0; i < requestsToRun; i++) {
      const reqStart = Date.now();
      try {
        const res = await fetch(url, {
          method,
          headers: {
            ...headers,
            ...(stringBody ? { 'Content-Type': 'application/json' } : {})
          },
          body: stringBody || undefined
        });

        const reqDuration = Date.now() - reqStart;
        latencies.push(reqDuration);

        if (res.ok) {
          successful++;
        } else {
          failed++;
        }
      } catch (err) {
        latencies.push(Date.now() - reqStart);
        failed++;
      }
    }
  }

  // Distribute requests across concurrent workers
  const reqsPerWorker = Math.floor(totalRequests / concurrency);
  const remainder = totalRequests % concurrency;
  const workers = [];

  for (let i = 0; i < concurrency; i++) {
    const count = reqsPerWorker + (i === 0 ? remainder : 0);
    workers.push(worker(count));
  }

  await Promise.all(workers);
  const totalDurationSec = (Date.now() - startTime) / 1000;
  const rps = (totalRequests / (totalDurationSec || 0.001)).toFixed(1);

  // Compute percentile statistics
  latencies.sort((a, b) => a - b);
  const p = (pct) => latencies[Math.floor((pct / 100) * (latencies.length - 1))] || 0;
  const avg = (latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1)).toFixed(1);

  const report = {
    name,
    totalRequests,
    concurrency,
    durationSec: totalDurationSec.toFixed(2),
    rps: Number(rps),
    successful,
    failed,
    errorRate: Number(((failed / totalRequests) * 100).toFixed(2)),
    avgLatencyMs: Number(avg),
    minLatencyMs: latencies[0] || 0,
    p50LatencyMs: p(50),
    p90LatencyMs: p(90),
    p95LatencyMs: p(95),
    p99LatencyMs: p(99),
    maxLatencyMs: latencies[latencies.length - 1] || 0
  };

  console.log(`\n📊 Performance Benchmark Results:`);
  console.log(`  • Throughput:      ${report.rps} req/sec`);
  console.log(`  • Success Rate:    ${report.successful}/${report.totalRequests} (${100 - report.errorRate}%)`);
  console.log(`  • Avg Latency:     ${report.avgLatencyMs} ms`);
  console.log(`  • p50 (Median):    ${report.p50LatencyMs} ms`);
  console.log(`  • p95 Latency:     ${report.p95LatencyMs} ms`);
  console.log(`  • p99 Latency:     ${report.p99LatencyMs} ms`);
  console.log(`  • Max Latency:     ${report.maxLatencyMs} ms`);

  return report;
}

module.exports = { executeLoadTest };
