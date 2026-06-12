import * as core from '@actions/core'
import * as fsHelper from './fs-helper'
import * as gitAuthHelper from './git-auth-helper'
import * as gitCommandManager from './git-command-manager'
import * as gitDirectoryHelper from './git-directory-helper'
import * as githubApiHelper from './github-api-helper'
import * as http from 'http'
import * as https from 'https'
import * as io from '@actions/io'
import * as path from 'path'
import * as refHelper from './ref-helper'
import * as stateHelper from './state-helper'
import * as urlHelper from './url-helper'
import {
  MinimumGitSparseCheckoutVersion,
  IGitCommandManager
} from './git-command-manager'
import {IGitSourceSettings} from './git-source-settings'

export async function getSource(settings: IGitSourceSettings): Promise<void> {
  // Repository URL
  core.info(
    `Syncing repository: ${settings.repositoryOwner}/${settings.repositoryName}`
  )
  const repositoryUrl = urlHelper.getFetchUrl(settings)

  // Remove conflicting file path
  if (fsHelper.fileExistsSync(settings.repositoryPath)) {
    await io.rmRF(settings.repositoryPath)
  }

  // Create directory
  let isExisting = true
  if (!fsHelper.directoryExistsSync(settings.repositoryPath)) {
    isExisting = false
    await io.mkdirP(settings.repositoryPath)
  }

  // Git command manager
  core.startGroup('Getting Git version info')
  const git = await getGitCommandManager(settings)
  core.endGroup()

  let authHelper: gitAuthHelper.IGitAuthHelper | null = null
  try {
    if (git) {
      authHelper = gitAuthHelper.createAuthHelper(git, settings)
      if (settings.setSafeDirectory) {
        // Setup the repository path as a safe directory, so if we pass this into a container job with a different user it doesn't fail
        // Otherwise all git commands we run in a container fail
        await authHelper.configureTempGlobalConfig()
        core.info(
          `Adding repository directory to the temporary git global config as a safe directory`
        )

        await git
          .config('safe.directory', settings.repositoryPath, true, true)
          .catch(error => {
            core.info(
              `Failed to initialize safe directory with error: ${error}`
            )
          })

        stateHelper.setSafeDirectory()
      }
    }

    // Prepare existing directory, otherwise recreate
    if (isExisting) {
      await gitDirectoryHelper.prepareExistingDirectory(
        git,
        settings.repositoryPath,
        repositoryUrl,
        settings.clean,
        settings.ref
      )
    }

    if (!git) {
      // Downloading using REST API
      core.info(`The repository will be downloaded using the GitHub REST API`)
      core.info(
        `To create a local Git repository instead, add Git ${gitCommandManager.MinimumGitVersion} or higher to the PATH`
      )
      if (settings.submodules) {
        throw new Error(
          `Input 'submodules' not supported when falling back to download using the GitHub REST API. To create a local Git repository instead, add Git ${gitCommandManager.MinimumGitVersion} or higher to the PATH.`
        )
      } else if (settings.sshKey) {
        throw new Error(
          `Input 'ssh-key' not supported when falling back to download using the GitHub REST API. To create a local Git repository instead, add Git ${gitCommandManager.MinimumGitVersion} or higher to the PATH.`
        )
      }

      await githubApiHelper.downloadRepository(
        settings.authToken,
        settings.repositoryOwner,
        settings.repositoryName,
        settings.ref,
        settings.commit,
        settings.repositoryPath,
        settings.githubServerUrl
      )
      return
    }

    // Save state for POST action
    stateHelper.setRepositoryPath(settings.repositoryPath)

    // Initialize the repository
    if (
      !fsHelper.directoryExistsSync(path.join(settings.repositoryPath, '.git'))
    ) {
      core.startGroup('Initializing the repository')
      await git.init()
      await git.remoteAdd('origin', repositoryUrl)
      core.endGroup()
    }

    // Disable automatic garbage collection
    core.startGroup('Disabling automatic garbage collection')
    if (!(await git.tryDisableAutomaticGarbageCollection())) {
      core.warning(
        `Unable to turn off git automatic garbage collection. The git fetch operation may trigger garbage collection and cause a delay.`
      )
    }
    core.endGroup()

    // If we didn't initialize it above, do it now
    if (!authHelper) {
      authHelper = gitAuthHelper.createAuthHelper(git, settings)
    }
    // Configure auth
    core.startGroup('Setting up auth')
    await authHelper.configureAuth()
    core.endGroup()

    // Determine the default branch
    if (!settings.ref && !settings.commit) {
      core.startGroup('Determining the default branch')
      if (settings.sshKey) {
        settings.ref = await git.getDefaultBranch(repositoryUrl)
      } else {
        settings.ref = await githubApiHelper.getDefaultBranch(
          settings.authToken,
          settings.repositoryOwner,
          settings.repositoryName,
          settings.githubServerUrl
        )
      }
      core.endGroup()
    }

    // LFS install
    if (settings.lfs) {
      await git.lfsInstall()
    }

    const lanCache = await configureLanCache(settings, git, authHelper)

    // Fetch
    core.startGroup('Fetching the repository')
    try {
      await fetchRepository(git, settings)
    } catch (error) {
      if (!lanCache.enabled || !settings.lanCacheFallback) {
        throw error
      }

      core.warning(
        `LAN cache fetch failed, retrying through GitHub origin. ${
          (error as any)?.message ?? error
        }`
      )
      await lanCache.disable()
      await fetchRepository(git, settings)
    } finally {
      await lanCache.disable()
    }
    core.endGroup()


    // Checkout info
    core.startGroup('Determining the checkout info')
    const checkoutInfo = await refHelper.getCheckoutInfo(
      git,
      settings.ref,
      settings.commit
    )
    core.endGroup()

    // LFS fetch
    // Explicit lfs-fetch to avoid slow checkout (fetches one lfs object at a time).
    // Explicit lfs fetch will fetch lfs objects in parallel.
    // For sparse checkouts, let `checkout` fetch the needed objects lazily.
    if (settings.lfs && !settings.sparseCheckout) {
      core.startGroup('Fetching LFS objects')
      await git.lfsFetch(checkoutInfo.startPoint || checkoutInfo.ref)
      core.endGroup()
    }

    // Sparse checkout
    if (!settings.sparseCheckout) {
      let gitVersion = await git.version()
      // no need to disable sparse-checkout if the installed git runtime doesn't even support it.
      if (gitVersion.checkMinimum(MinimumGitSparseCheckoutVersion)) {
        await git.disableSparseCheckout()
      }
    } else {
      core.startGroup('Setting up sparse checkout')
      if (settings.sparseCheckoutConeMode) {
        await git.sparseCheckout(settings.sparseCheckout)
      } else {
        await git.sparseCheckoutNonConeMode(settings.sparseCheckout)
      }
      core.endGroup()
    }

    // Checkout
    core.startGroup('Checking out the ref')
    await git.checkout(checkoutInfo.ref, checkoutInfo.startPoint)
    core.endGroup()

    // Submodules
    if (settings.submodules) {
      // Temporarily override global config
      core.startGroup('Setting up auth for fetching submodules')
      await authHelper.configureGlobalAuth()
      core.endGroup()

      // Checkout submodules
      core.startGroup('Fetching submodules')
      await git.submoduleSync(settings.nestedSubmodules)
      await git.submoduleUpdate(settings.fetchDepth, settings.nestedSubmodules)
      await git.submoduleForeach(
        'git config --local gc.auto 0',
        settings.nestedSubmodules
      )
      core.endGroup()

      // Persist credentials
      if (settings.persistCredentials) {
        core.startGroup('Persisting credentials for submodules')
        await authHelper.configureSubmoduleAuth()
        core.endGroup()
      }
    }

    // Get commit information
    const commitInfo = await git.log1()

    // Log commit sha
    const commitSHA = await git.log1('--format=%H')
    core.setOutput('commit', commitSHA.trim())

    // Check for incorrect pull request merge commit
    await refHelper.checkCommitInfo(
      settings.authToken,
      commitInfo,
      settings.repositoryOwner,
      settings.repositoryName,
      settings.ref,
      settings.commit,
      settings.githubServerUrl
    )
  } finally {
    // Remove auth
    if (authHelper) {
      if (!settings.persistCredentials) {
        core.startGroup('Removing auth')
        await authHelper.removeAuth()
        core.endGroup()
      }
      authHelper.removeGlobalConfig()
    }
  }
}

async function fetchRepository(
  git: IGitCommandManager,
  settings: IGitSourceSettings
): Promise<void> {
  const fetchOptions: {
    filter?: string
    fetchDepth?: number
    fetchTags?: boolean
    showProgress?: boolean
  } = {}

  if (settings.filter) {
    fetchOptions.filter = settings.filter
  } else if (settings.sparseCheckout) {
    fetchOptions.filter = 'blob:none'
  }

  if (settings.fetchDepth <= 0) {
    // Fetch all branches and tags
    let refSpec = refHelper.getRefSpecForAllHistory(
      settings.ref,
      settings.commit
    )
    await git.fetch(refSpec, fetchOptions)

    // When all history is fetched, the ref we're interested in may have moved to a different
    // commit (push or force push). If so, fetch again with a targeted refspec.
    if (!(await refHelper.testRef(git, settings.ref, settings.commit))) {
      refSpec = refHelper.getRefSpec(settings.ref, settings.commit)
      await git.fetch(refSpec, fetchOptions)
    }
  } else {
    fetchOptions.fetchDepth = settings.fetchDepth
    fetchOptions.fetchTags = settings.fetchTags
    const refSpec = refHelper.getRefSpec(settings.ref, settings.commit)
    await git.fetch(refSpec, fetchOptions)
  }
}

async function configureLanCache(
  settings: IGitSourceSettings,
  git: IGitCommandManager,
  authHelper: gitAuthHelper.IGitAuthHelper
): Promise<{enabled: boolean; disable: () => Promise<void>}> {
  const disabled = {
    enabled: false,
    disable: async () => {}
  }

  if (!settings.lanCacheApi || !settings.lanCacheGitBase) {
    return disabled
  }

  const cacheGitUrl = getLanCacheGitUrl(settings)
  const insteadOfKey = `url.${cacheGitUrl}.insteadOf`

  try {
    await ensureLanCache(settings)

    // Reuse checkout's temporary global config mechanism. This writes only to
    // RUNNER_TEMP/HOME for this action's git commands, not the runner user's
    // real global git config.
    await authHelper.configureTempGlobalConfig()
    await git.tryConfigUnset(insteadOfKey, true)

    for (const value of getLanCacheInsteadOfValues(settings)) {
      await git.config(insteadOfKey, value, true, true)
    }

    core.info(
      `LAN git cache enabled for ${settings.repositoryOwner}/${settings.repositoryName}: ${cacheGitUrl}`
    )

    return {
      enabled: true,
      disable: async () => {
        await git.tryConfigUnset(insteadOfKey, true)
      }
    }
  } catch (error) {
    await git.tryConfigUnset(insteadOfKey, true)
    core.info(
      `LAN git cache unavailable, using GitHub origin. ${
        (error as any)?.message ?? error
      }`
    )
    return disabled
  }
}

function getLanCacheGitUrl(settings: IGitSourceSettings): string {
  const base = settings.lanCacheGitBase.replace(/\/+$/, '')
  const repo = settings.lanCacheRepository.endsWith('.git')
    ? settings.lanCacheRepository
    : `${settings.lanCacheRepository}.git`
  return `${base}/${repo}`
}

function getLanCacheInsteadOfValues(settings: IGitSourceSettings): string[] {
  const serverUrl = urlHelper.getServerUrl(settings.githubServerUrl)
  const repo = `${settings.repositoryOwner}/${settings.repositoryName}`
  return [
    `${serverUrl.origin}/${repo}.git`,
    `${serverUrl.origin}/${repo}`,
    `git@${serverUrl.hostname}:${repo}.git`,
    `git@${serverUrl.hostname}:${repo}`
  ]
}

async function ensureLanCache(settings: IGitSourceSettings): Promise<void> {
  const apiBase = settings.lanCacheApi.replace(/\/+$/, '')
  const endpoint = settings.lanCacheEnsureEndpoint.startsWith('/')
    ? settings.lanCacheEnsureEndpoint
    : `/${settings.lanCacheEnsureEndpoint}`

  await requestLanCache(`${apiBase}/health`, 'GET')
  await requestLanCache(`${apiBase}${endpoint}`, 'POST', '{}')
}

async function requestLanCache(
  requestUrl: string,
  method: 'GET' | 'POST',
  body?: string
): Promise<void> {
  const url = new URL(requestUrl)
  const client = url.protocol === 'https:' ? https : http

  await new Promise<void>((resolve, reject) => {
    const req = client.request(
      url,
      {
        method,
        timeout: 3600_000,
        headers: body
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body).toString()
            }
          : undefined
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve()
          } else {
            reject(
              new Error(
                `${method} ${requestUrl} failed with status ${
                  res.statusCode
                }: ${responseBody.slice(0, 1000)}`
              )
            )
          }
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error(`${method} ${requestUrl} timed out`))
    })
    req.on('error', reject)

    if (body) {
      req.write(body)
    }
    req.end()
  })
}

export async function cleanup(repositoryPath: string): Promise<void> {
  // Repo exists?
  if (
    !repositoryPath ||
    !fsHelper.fileExistsSync(path.join(repositoryPath, '.git', 'config'))
  ) {
    return
  }

  let git: IGitCommandManager
  try {
    git = await gitCommandManager.createCommandManager(
      repositoryPath,
      false,
      false
    )
  } catch {
    return
  }

  // Remove auth
  const authHelper = gitAuthHelper.createAuthHelper(git)
  try {
    if (stateHelper.PostSetSafeDirectory) {
      // Setup the repository path as a safe directory, so if we pass this into a container job with a different user it doesn't fail
      // Otherwise all git commands we run in a container fail
      await authHelper.configureTempGlobalConfig()
      core.info(
        `Adding repository directory to the temporary git global config as a safe directory`
      )

      await git
        .config('safe.directory', repositoryPath, true, true)
        .catch(error => {
          core.info(`Failed to initialize safe directory with error: ${error}`)
        })
    }

    await authHelper.removeAuth()
  } finally {
    await authHelper.removeGlobalConfig()
  }
}

async function getGitCommandManager(
  settings: IGitSourceSettings
): Promise<IGitCommandManager | undefined> {
  core.info(`Working directory is '${settings.repositoryPath}'`)
  try {
    return await gitCommandManager.createCommandManager(
      settings.repositoryPath,
      settings.lfs,
      settings.sparseCheckout != null
    )
  } catch (err) {
    // Git is required for LFS
    if (settings.lfs) {
      throw err
    }

    // Otherwise fallback to REST API
    return undefined
  }
}
