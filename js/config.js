/**
 * Product definitions, mirroring src/vietlott/config/products.py and the
 * crawler product classes from vietvudanh/vietlott-data.
 */

export const PRODUCTS = {
  power_655: {
    key: 'power_655',
    label: 'Power 6/55',
    min: 1,
    max: 55,
    pick: 6,          // size_output
    hasBonus: true,   // result = 6 main + 1 bonus
    file: 'power655.jsonl',
    url: 'https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts.Game655CompareWebPart,Vietlott.PlugIn.WebParts.ashx',
    ajaxKey: '23bbd667',
    referer: 'https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/655',
    // Prize table from src/machine_learning/strategies/base.py
    ticketPrice: 10000,
    prizes: { 6: 40000000000, 5: 5000000000, 4: 500000, 3: 50000 },
    prizesAreRepoDefault: true,
  },
  power_645: {
    key: 'power_645',
    label: 'Power 6/45 (Mega)',
    min: 1,
    max: 45,
    pick: 6,
    hasBonus: false,
    file: 'power645.jsonl',
    url: 'https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts.Game645CompareWebPart,Vietlott.PlugIn.WebParts.ashx',
    ajaxKey: '8290fce2',
    referer: 'https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/645',
    ticketPrice: 10000,
    // The repo only defines a prize table for 6/55. These are estimates -
    // edit them in the Backtest tab before reading any ROI number as real.
    prizes: { 6: 12000000000, 5: 10000000, 4: 300000, 3: 30000 },
    prizesAreRepoDefault: false,
  },
  power_535: {
    key: 'power_535',
    label: 'Power 5/35',
    min: 1,
    max: 35,
    pick: 5,
    hasBonus: true,   // result = 5 main + 1 bonus
    file: 'power535.jsonl',
    url: 'https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts.Game535CompareWebPart,Vietlott.PlugIn.WebParts.ashx',
    ajaxKey: 'd0ea794f',
    referer: 'https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/535',
    ticketPrice: 10000,
    // Estimates - see note above.
    prizes: { 5: 3000000000, 4: 300000, 3: 30000 },
    prizesAreRepoDefault: false,
  },
};

export const DEFAULT_PRODUCT = 'power_655';

/** Upstream repo, used as the no-proxy data source. */
export const GITHUB_RAW =
  'https://raw.githubusercontent.com/vietvudanh/vietlott-data/master/data/';

export const STORAGE_PREFIX = 'vietlott.';
