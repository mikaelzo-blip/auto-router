import "dotenv/config";
import { BenchmarkRunner, PRIMARY_CALIBRATION_CANDIDATES } from "../../src/benchmark/harness.js";
import type { BenchmarkFilterOptions } from "../../src/benchmark/types.js";

function parseArgs(): BenchmarkFilterOptions {
  const args = process.argv.slice(2);
  const options: BenchmarkFilterOptions = {
    resume: false,
    attempts: 1,
    models: [...PRIMARY_CALIBRATION_CANDIDATES],
    outputPath: "benchmark/full-results.json"
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--model" && args[i + 1]) {
      options.models = args[++i]!.split(",").map((s) => s.trim());
    } else if (arg === "--case" && args[i + 1]) {
      options.caseIds = args[++i]!.split(",").map((s) => s.trim());
    } else if (arg === "--category" && args[i + 1]) {
      options.categories = args[++i]!.split(",").map((s) => s.trim());
    } else if (arg === "--attempts" && args[i + 1]) {
      options.attempts = parseInt(args[++i]!, 10);
    } else if (arg === "--timeout" && args[i + 1]) {
      options.timeoutMs = parseInt(args[++i]!, 10);
    } else if (arg === "--output" && args[i + 1]) {
      options.outputPath = args[++i]!;
    } else if (arg === "--judge" && args[i + 1]) {
      options.judgeModel = args[++i]!;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();
  const runner = new BenchmarkRunner({ outputPath: options.outputPath });
  console.log("=== FULL CORPUS BENCHMARK ===");
  console.log("Configuration:", {
    models: options.models?.length,
    resume: options.resume,
    outputPath: options.outputPath
  });

  const summary = await runner.run(options);
  console.log("\n=== FULL BENCHMARK SUMMARY ===");
  console.log(`Total Records: ${summary.totalRecords}`);
  console.log(`Operational Success Rate: ${(summary.overallOperationalSuccessRate * 100).toFixed(1)}%`);
  console.log(`Quality Success Rate When Executed: ${(summary.overallQualitySuccessRateWhenExecuted * 100).toFixed(1)}%`);
  console.log(`Denominator Uniform: ${summary.denominatorUniform ? "YES" : "NO"}`);
}

main().catch((err) => {
  console.error("Full benchmark failed:", err);
  process.exit(1);
});
