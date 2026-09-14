/**
 * The commit this build came from.
 *
 * Deploys go out through the CLI rather than Vercel's git integration, so no commit
 * metadata is attached to a deployment and there is no way to ask the live site which
 * revision it is running — a question worth being able to answer before a submission.
 * CI overwrites this file with the real SHA immediately before `vercel build`; the value
 * below is what a local build reports.
 */
export const BUILD_SHA = 'local';
