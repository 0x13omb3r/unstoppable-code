// A narrow entry so app shells can mount the New Customize switch (CAN-6809)
// without loading the whole capability barrel at startup.
export {
  CustomizeDiscoveryProvider,
  useCustomizeDiscoveryEnabled,
  useCustomizeDiscoveryFilters,
} from './capability/CustomizeDiscoveryProvider';
