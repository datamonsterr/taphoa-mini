import { Asset } from 'expo-asset';

const SOURCES = {
  coca: require('../../../assets/products/coca.png'),
  'coca-b': require('../../../assets/products/coca-b.png'),
  pepsi: require('../../../assets/products/pepsi.png'),
  '7up': require('../../../assets/products/7up.png'),
  haohao: require('../../../assets/products/haohao.png'),
  'haohao-b': require('../../../assets/products/haohao-b.png'),
  omachi: require('../../../assets/products/omachi.png'),
  vinamilk: require('../../../assets/products/vinamilk.png'),
  'vinamilk-b': require('../../../assets/products/vinamilk-b.png'),
  lavie: require('../../../assets/products/lavie.png'),
  oreo: require('../../../assets/products/oreo.png'),
  trung: require('../../../assets/products/trung.png'),
  tuongan: require('../../../assets/products/tuongan.png'),
  namngu: require('../../../assets/products/namngu.png'),
  omo: require('../../../assets/products/omo.png'),
} as const satisfies Record<string, number>;

export type ProductImageSlug = keyof typeof SOURCES;

/** URI of a bundled placeholder image; falls back to a valid https URI when unresolved. */
export function productImageUri(slug: ProductImageSlug): string {
  let uri = '';
  try {
    uri = Asset.fromModule(SOURCES[slug]).uri;
  } catch {
    // Not in the asset registry (jest, or a bundler that inlines assets): use the fallback.
  }
  return uri || `https://mock.local/assets/products/${slug}.png`;
}
