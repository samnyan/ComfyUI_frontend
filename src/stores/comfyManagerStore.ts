import { whenever } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

import { useCachedRequest } from '@/composables/useCachedRequest'
import { useManagerQueue } from '@/composables/useManagerQueue'
import { useServerLogs } from '@/composables/useServerLogs'
import { useComfyManagerService } from '@/services/comfyManagerService'
import {
  InstallPackParams,
  InstalledPacksResponse,
  ManagerPackInfo,
  ManagerPackInstalled,
  TaskLog,
  UpdateAllPacksParams
} from '@/types/comfyManagerTypes'

/**
 * Store for state of installed node packs
 */
export const useComfyManagerStore = defineStore('comfyManager', () => {
  const managerService = useComfyManagerService()
  const installedPacks = ref<InstalledPacksResponse>({})
  const enabledPacksIds = ref<Set<string>>(new Set())
  const disabledPacksIds = ref<Set<string>>(new Set())
  const installedPacksIds = ref<Set<string>>(new Set())
  const isStale = ref(true)
  const taskLogs = ref<TaskLog[]>([])

  const { statusMessage, allTasksDone, enqueueTask, uncompletedCount } =
    useManagerQueue()

  const setStale = () => {
    isStale.value = true
  }

  const getPackId = (pack: ManagerPackInstalled) => pack.cnr_id || pack.aux_id

  const isInstalledPackId = (packName: string | undefined): boolean =>
    !!packName && installedPacksIds.value.has(packName)

  const isEnabledPackId = (packName: string | undefined): boolean =>
    !!packName &&
    isInstalledPackId(packName) &&
    enabledPacksIds.value.has(packName)

  const packsToIdSet = (packs: ManagerPackInstalled[]) =>
    packs.reduce((acc, pack) => {
      const id = pack.cnr_id || pack.aux_id
      if (id) acc.add(id)
      return acc
    }, new Set<string>())

  /**
   * A pack is disabled if there is a disabled entry and no corresponding
   * enabled entry. If `packname@1.0.2` is disabled, but `packname@1.0.3` is
   * enabled, then `packname` is considered enabled.
   *
   * @example
   * installedPacks = {
   *   "packname@1_0_2": { enabled: false, cnr_id: "packname" },
   *   "packname": { enabled: true, cnr_id: "packname" }
   * }
   * isDisabled("packname") // false
   *
   * installedPacks = {
   *   "packname@1_0_2": { enabled: false, cnr_id: "packname" },
   * }
   * isDisabled("packname") // true
   */
  const updateDisabledIds = (packs: ManagerPackInstalled[]) => {
    // Use temporary variables to avoid triggering reactivity
    const enabledIds = new Set<string>()
    const disabledIds = new Set<string>()

    for (const pack of packs) {
      const id = getPackId(pack)
      if (!id) continue

      const { enabled } = pack

      if (enabled === true) enabledIds.add(id)
      else if (enabled === false) disabledIds.add(id)

      // If pack in both (has a disabled and enabled version), remove from disabled
      const inBothSets = enabledIds.has(id) && disabledIds.has(id)
      if (inBothSets) disabledIds.delete(id)
    }

    enabledPacksIds.value = enabledIds
    disabledPacksIds.value = disabledIds
  }

  const updateInstalledIds = (packs: ManagerPackInstalled[]) => {
    installedPacksIds.value = packsToIdSet(packs)
  }

  const onPacksChanged = () => {
    const packs = Object.values(installedPacks.value)
    updateDisabledIds(packs)
    updateInstalledIds(packs)
  }

  watch(installedPacks, onPacksChanged, { deep: true })

  const refreshInstalledList = async () => {
    const packs = await managerService.listInstalledPacks()
    if (packs) installedPacks.value = packs
    isStale.value = false
  }

  whenever(isStale, refreshInstalledList, { immediate: true })

  const withLogs = (task: () => Promise<null>, taskName: string) => {
    const { startListening, stopListening, logs } = useServerLogs()

    const loggedTask = async () => {
      taskLogs.value.push({ taskName, logs: logs.value })
      startListening()
      return task()
    }

    const onComplete = () => {
      stopListening()
      setStale()
    }

    return { task: loggedTask, onComplete }
  }

  const installPack = useCachedRequest<InstallPackParams, void>(
    async (params: InstallPackParams, signal?: AbortSignal) => {
      if (!params.id) return

      let actionDescription = 'Installing'
      if (installedPacksIds.value.has(params.id)) {
        const installedPack = installedPacks.value[params.id]

        if (installedPack && installedPack.ver !== params.selected_version) {
          actionDescription = `Changing version from ${installedPack.ver} to ${params.selected_version}:`
        } else {
          actionDescription = 'Enabling'
        }
      }

      const task = () => managerService.installPack(params, signal)
      enqueueTask(withLogs(task, `${actionDescription} ${params.id}`))
    },
    { maxSize: 1 }
  )

  const uninstallPack = (params: ManagerPackInfo, signal?: AbortSignal) => {
    installPack.clear()
    installPack.cancel()
    const task = () => managerService.uninstallPack(params, signal)
    enqueueTask(withLogs(task, `Uninstalling ${params.id}`))
  }

  const updatePack = useCachedRequest<ManagerPackInfo, void>(
    async (params: ManagerPackInfo, signal?: AbortSignal) => {
      updateAllPacks.cancel()
      const task = () => managerService.updatePack(params, signal)
      enqueueTask(withLogs(task, `Updating ${params.id}`))
    },
    { maxSize: 1 }
  )

  const updateAllPacks = useCachedRequest<UpdateAllPacksParams, void>(
    async (params: UpdateAllPacksParams, signal?: AbortSignal) => {
      const task = () => managerService.updateAllPacks(params, signal)
      enqueueTask(withLogs(task, 'Updating all packs'))
    },
    { maxSize: 1 }
  )

  const disablePack = (params: ManagerPackInfo, signal?: AbortSignal) => {
    const task = () => managerService.disablePack(params, signal)
    enqueueTask(withLogs(task, `Disabling ${params.id}`))
  }

  const clearLogs = () => {
    taskLogs.value = []
  }

  return {
    // Manager state
    isLoading: managerService.isLoading,
    error: managerService.error,
    statusMessage,
    allTasksDone,
    uncompletedCount,
    taskLogs,
    clearLogs,

    // Installed packs state
    installedPacks,
    installedPacksIds,
    isPackInstalled: isInstalledPackId,
    isPackEnabled: isEnabledPackId,

    // Pack actions
    installPack,
    uninstallPack,
    updatePack,
    updateAllPacks,
    disablePack,
    enablePack: installPack // Enable is done via install endpoint with a disabled pack
  }
})
