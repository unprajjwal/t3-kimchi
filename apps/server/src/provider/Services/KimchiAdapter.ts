/**
 * KimchiAdapter — shape type for the Kimchi provider adapter.
 *
 * The driver model ({@link ../Drivers/KimchiDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module KimchiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * KimchiAdapterShape — per-instance Kimchi adapter contract.
 */
export interface KimchiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
