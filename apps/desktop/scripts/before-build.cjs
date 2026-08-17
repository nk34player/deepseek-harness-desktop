'use strict'
/**
 * Skip electron-builder's dependency installation entirely. The shell has no
 * in-process native dependencies (see npmRebuild: false in electron-builder.yml),
 * and the workspace install already populated node_modules. Running electron-builder's
 * own `pnpm install --production` from inside this pnpm workspace would prune
 * devDependencies and then trip the root postinstall (install-lefthook.mjs),
 * so resolving false here keeps packaging purely a copy of the existing tree.
 * @returns false to skip dependency installation.
 */
module.exports = async () => false
