import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` writes AGENTS.md and CLAUDE.md into the repo root for AI coding tools.
  // They are tooling notes, not part of this project, and they read strangely to anyone
  // opening the repository — so they are not generated, and .gitignore refuses them too.
  agentRules: false,
};

export default nextConfig;
