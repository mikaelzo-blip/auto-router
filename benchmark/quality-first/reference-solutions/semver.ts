export function compareSemver(v1: string, v2: string): -1 | 0 | 1 {
  const parse = (v: string) => {
    // Strip build metadata
    const withoutBuild = v.split("+")[0]!;
    const parts = withoutBuild.split("-");
    const core = parts[0]!;
    const pre = parts.length > 1 ? parts.slice(1).join("-") : null;

    const coreParts = core.split(".");
    if (coreParts.length !== 3) {
      throw new Error(`Invalid semver core version: ${v}`);
    }

    const major = Number(coreParts[0]);
    const minor = Number(coreParts[1]);
    const patch = Number(coreParts[2]);

    if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch) || major < 0 || minor < 0 || patch < 0) {
      throw new Error(`Invalid semver numeric parts: ${v}`);
    }

    return { major, minor, patch, pre };
  };

  const p1 = parse(v1);
  const p2 = parse(v2);

  if (p1.major !== p2.major) return p1.major < p2.major ? -1 : 1;
  if (p1.minor !== p2.minor) return p1.minor < p2.minor ? -1 : 1;
  if (p1.patch !== p2.patch) return p1.patch < p2.patch ? -1 : 1;

  // When core versions equal: normal version has HIGHER precedence than pre-release version
  if (!p1.pre && !p2.pre) return 0;
  if (!p1.pre && p2.pre) return 1;
  if (p1.pre && !p2.pre) return -1;

  // Compare pre-release identifiers dot-separated
  const id1 = p1.pre!.split(".");
  const id2 = p2.pre!.split(".");
  const len = Math.max(id1.length, id2.length);

  for (let i = 0; i < len; i++) {
    const a = id1[i];
    const b = id2[i];

    if (a === undefined) return -1; // smaller set has lower precedence
    if (b === undefined) return 1;

    if (a === b) continue;

    const isNumA = /^\d+$/.test(a);
    const isNumB = /^\d+$/.test(b);

    if (isNumA && isNumB) {
      const numA = Number(a);
      const numB = Number(b);
      if (numA !== numB) return numA < numB ? -1 : 1;
    } else if (isNumA && !isNumB) {
      // Numeric identifiers always have lower precedence than non-numeric
      return -1;
    } else if (!isNumA && isNumB) {
      return 1;
    } else {
      // Lexical ASCII comparison
      return a < b ? -1 : 1;
    }
  }

  return 0;
}
