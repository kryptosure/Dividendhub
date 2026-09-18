/* backend/src/services/stockUniverse.js
 * Full dividend universe — ~670 tickers, organized by frequency tier.
 * Includes daily/weekly/monthly high-frequency ETFs and preferred stocks.
 * Now includes Canada (TSX) — see the `ca` block at the bottom.
 */

const UNIVERSE = {
  us: {
    // ---------- DAILY-PAYING PREFERRED STOCKS ----------
    dailyPreferred: [
      'SATA',   // Strive Variable Rate Series A Perpetual Preferred
      'CHAD',   // DFDV Solana treasury perpetual preferred
    ],

    // ---------- WEEKLY-PAYING ETFs ----------
    weeklyEtfs: [
      'YMAX', 'YMAG', 'ULTY', 'SLTY', 'FEAT', 'FIVY',
      'CHPY', 'GPTY', 'LFGY', 'YRAM', 'MINY', 'QDTY', 'RDTY', 'SDTY',
      'ABNY', 'AIYY', 'AMDY', 'AMZY', 'APLY', 'BABO', 'BRKC', 'CONY',
      'CRCO', 'CVNY', 'DISO', 'DRAY', 'FBY', 'GDXY', 'GMEY', 'GOOY',
      'HIYY', 'HOOY', 'JPMO', 'MARO', 'MRNY', 'MSFO', 'MSTY', 'NFLY',
      'NVDY', 'OARK', 'PLTY', 'PYY', 'RBLY', 'RDYY', 'SMCY', 'SNOY',
      'TSLY', 'TSMY', 'XOMO', 'XYZY', 'YBIT', 'FIAT', 'CRSH', 'DIPS',
      'YQQQ', 'WNTR', 'PYPY', 'XDTE', 'QDTE', 'RDTE', 'MAGY',
      'AAPW', 'ABNW', 'AMDW', 'AMZW', 'ARMW', 'ASMW', 'AVGW', 'BABW',
      'BRKW', 'COIW', 'COSW', 'CRWW', 'DKNW', 'GOOW', 'HOOW', 'LMTW',
      'METAW', 'MSFW', 'MSTRW', 'NFLW', 'NVW', 'PLTW', 'RDDW', 'SHOW',
      'SPOW', 'TSLW', 'TSMW', 'UBEW', 'UNHW', 'XOMW', 'WDTE', 'QQQY',
      'IWMY', 'SPYT', 'QQQT', 'GLDY', 'MST', 'NVYY', 'XBTY', 'AMYY',
      'TQQY', 'COYY', 'TSYY', 'YSPY', 'IOYY', 'MUYY', 'QBY', 'RGYY',
      'FIYY', 'CRY', 'FEPI', 'AIPI', 'CEPI', 'WEEK', 'YBTC', 'BCCC',
      'JMMF', 'YBST',
    ],

    // ---------- MONTHLY-PAYING ETFs ----------
    monthlyEtfs: [
      'JEPI', 'JEPQ', 'SPYI', 'QQQI', 'DIVO', 'NUSI', 'QYLG', 'XYLG',
      'GPIQ', 'SDIV', 'RYLD', 'JPIE', 'PFF', 'PGX', 'BKLN', 'SRLN',
      'FTSL', 'VNQ', 'SCHH', 'RWR', 'IYR', 'REET', 'RIET',
    ],

    // ---------- MONTHLY-PAYING STOCKS (REITs, BDCs, CEFs) ----------
    monthlyStocks: [
      'O', 'STAG', 'LAND', 'LTC', 'ADC', 'EPR', 'GOOD', 'DOC', 'PECO',
      'IRM', 'GLPI', 'VTR', 'OHI', 'SBAC', 'KIM', 'REG', 'FRT', 'BXP',
      'UHT', 'SLG', 'GTY', 'LXP', 'AAT', 'DEA', 'OLP', 'PLYM',
      'MAIN', 'PFLT', 'GAIN', 'PSEC', 'OBDC', 'BXSL', 'HTGC', 'TRIN',
      'GLAD', 'OXLC', 'OCCI', 'ARCC', 'FSK', 'NMFC', 'CSWC', 'TPVG',
      'AGNC', 'ARR', 'ORC', 'NLY', 'STWD', 'IVR', 'MFA', 'TWO', 'PMT',
      'CIM', 'RITM', 'DX', 'ABR', 'IGA', 'IGD', 'IDE', 'IAE', 'IHD',
      'HPI', 'HPF', 'HPS', 'PDI', 'PTY', 'PCN', 'PCM', 'RCS', 'UTF',
      'ETV', 'ETB', 'ETY', 'BDJ', 'BME', 'BOE', 'BUI', 'EOI', 'EOS',
      'ETG', 'ETJ', 'ETO', 'ITUB', 'BBD', 'ABEV', 'PBR', 'VALE', 'SID',
      'ENB', 'PBA', 'TRP', 'BCE', 'TU', 'CNQ', 'SU', 'CVE', 'IMO',
    ],

    // ---------- QUARTERLY-PAYING DIVIDEND STOCKS ----------
    stocks: [
      'KO', 'PEP', 'PG', 'MO', 'PM', 'KHC', 'K', 'GIS', 'KMB', 'CL',
      'CLX', 'SYY', 'HSY', 'MDLZ', 'STZ', 'TAP', 'KR', 'WMT', 'COST',
      'TGT', 'HRL', 'CAG', 'SJM', 'CPB', 'MKC', 'CHD', 'EL', 'KDP', 'MNST',
      'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'BMY', 'AMGN', 'GILD', 'MDT',
      'ABT', 'UNH', 'CVS', 'CI', 'HUM', 'BDX', 'BAX', 'ZBH', 'SYK',
      'BSX', 'ELV', 'DHR', 'TMO', 'A', 'WAT', 'RMD', 'ZTS',
      'VZ', 'T', 'TMUS', 'CMCSA', 'DIS', 'V', 'MA', 'NFLX', 'CHTR', 'WBD',
      'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BLK', 'SCHW', 'AXP', 'USB',
      'PNC', 'TFC', 'COF', 'BK', 'STT', 'AIG', 'MET', 'PRU', 'AFL', 'TRV',
      'HBAN', 'FITB', 'RF', 'KEY', 'CFG', 'MTB', 'CMA', 'ZION', 'ALL',
      'CB', 'PGR', 'MMC', 'AJG', 'WTW', 'BRO', 'XOM', 'CVX', 'COP', 'EOG',
      'PSX', 'VLO', 'MPC', 'KMI', 'WMB', 'OKE', 'EPD', 'ET', 'PAA', 'SLB',
      'HAL', 'BKR', 'OXY', 'DVN', 'FANG', 'NEE', 'DUK', 'SO', 'D', 'AEP',
      'EXC', 'XEL', 'ED', 'WEC', 'ES', 'PEG', 'FE', 'PPL', 'CMS', 'DTE',
      'AEE', 'ETR', 'CNP', 'AWR', 'BKH', 'NWE', 'OGE', 'POR', 'AVA', 'IDA',
      'MGEE', 'MMM', 'CAT', 'DE', 'HON', 'LMT', 'RTX', 'GD', 'NOC', 'BA',
      'GE', 'UNP', 'CSX', 'NSC', 'UPS', 'FDX', 'WM', 'RSG', 'ITW', 'EMR',
      'ETN', 'ADP', 'ABM', 'GPC', 'PH', 'ROK', 'DOV', 'SWK', 'FAST', 'MCD',
      'HD', 'LOW', 'SBUX', 'NKE', 'TJX', 'F', 'GM', 'DRI', 'YUM', 'CMG',
      'BBY', 'WSM', 'AAPL', 'MSFT', 'IBM', 'INTC', 'CSCO', 'TXN', 'AVGO',
      'QCOM', 'ADI', 'HPQ', 'HPE', 'AMAT', 'KLAC', 'LRCX', 'MU', 'ORCL',
      'NXPI', 'MCHP', 'SWKS', 'STX', 'LIN', 'APD', 'SHW', 'ECL', 'DD',
      'DOW', 'NEM', 'FCX', 'VMC', 'MLM', 'PPG', 'IFF', 'ALB', 'NUE', 'STLD',
      'PLD', 'AMT', 'CCI', 'EQIX', 'PSA', 'EXR', 'WELL', 'DLR', 'AVB',
      'EQR', 'ESS', 'MAA', 'UDR', 'NNN', 'WPC', 'MPW', 'CUBE', 'IIPR',
      'REXR', 'COLD', 'ADM', 'AOS', 'ATO', 'CAH', 'CHRW', 'CINF', 'CTAS',
      'EXPD', 'GWW', 'LEG', 'PNR', 'ROP', 'SPGI', 'TROW', 'VFC',
    ],

    // ---------- QUARTERLY-PAYING DIVIDEND ETFs ----------
    etfs: [
      'SCHD', 'VYM', 'VIG', 'DVY', 'HDV', 'SPHD', 'SDY', 'DGRO', 'NOBL',
      'RDVY', 'DGRW', 'SCHV', 'VTV', 'IVE', 'SPYD', 'PEY', 'DON', 'FVD',
      'RWL', 'FDVV', 'CGDV', 'JDIV', 'SCHY', 'TDVG', 'VYMI', 'IDV',
      'SPY', 'QQQ', 'VTI', 'VOO', 'IVV', 'IWM', 'DIA', 'RSP', 'VXUS',
      'VEA', 'VWO', 'EFA', 'IEFA', 'ACWI', 'VT', 'ITOT', 'SCHB',
      'XLK', 'XLF', 'XLE', 'XLI', 'XLV', 'XLY', 'XLP', 'XLU', 'XLB',
      'XLRE', 'XLC', 'VPU', 'VHT', 'VFH', 'VIS', 'VDE',
    ],

    // ---------- BOND ETFs ----------
    bondEtfs: [
      'AGG', 'BND', 'TLT', 'IEF', 'SHY', 'GOVT', 'SCHZ', 'SGOV', 'BIL',
      'SPTL', 'SPTI', 'SPTS', 'SPIB', 'VGSH', 'VGIT', 'VGLT', 'VCSH',
      'VCIT', 'VCLT', 'LQD', 'HYG', 'JNK', 'USIG', 'IGIB', 'SJNK',
      'SHYG', 'HYLB', 'ANGL', 'FALN', 'MUB', 'VTEB', 'TFI', 'BNDX',
      'EMB', 'IEMB', 'IGOV', 'BWX', 'VTIP', 'TIP', 'STIP', 'FLOT',
      'FLRN', 'NEAR', 'JPST', 'MINT',
    ],
  },

  sg: {
    stocks: [
      'D05.SI', 'O39.SI', 'U11.SI', 'Z74.SI', 'CC3.SI',
      'C6L.SI', 'C52.SI', 'S63.SI', 'S68.SI', 'BN4.SI', 'S58.SI',
      'S61.SI', 'U96.SI', 'V03.SI', 'BS6.SI', 'F34.SI', 'G13.SI', 'P8Z.SI',
      'OV8.SI', 'D01.SI', 'Y03.SI', 'C07.SI', 'C09.SI', 'U14.SI', 'H78.SI',
      'Z25.SI', 'T24.SI', 'K17.SI', 'BVA.SI', 'AWX.SI', 'E28.SI', '5LY.SI',
      'J36.SI', 'P15.SI', 'T39.SI', 'U10.SI', 'Y92.SI', 'H02.SI',
      'C41.SI', 'BN2.SI', 'G07.SI', 'M01.SI', 'G92.SI', 'P34.SI',
    ],
    reits: [
      'C38U.SI', 'A17U.SI', 'M44U.SI', 'ME8U.SI', 'N2IU.SI',
      'J69U.SI', 'BUOU.SI', 'AJBU.SI', 'K71U.SI', 'T82U.SI',
      'P40U.SI', 'TS0U.SI', 'SK6U.SI', 'C2PU.SI', 'HMN.SI',
      'CWBU.SI', 'OXMU.SI', 'BTOU.SI', 'DHLU.SI', 'DCRU.SI',
      'ODBU.SI', 'XZL.SI', 'MXNU.SI', '5WA.SI', 'BWCU.SI',
      'AW9U.SI', 'ACV.SI', 'AU8U.SI', 'J85.SI', 'O5RU.SI',
      'Y92.SI', 'CEDU.SI', 'UD1U.SI', 'T8JU.SI', 'NS8U.SI', 'CJLU.SI',
    ],
    etfs: [
      'ES3.SI', 'G3B.SI', 'CLR.SI', 'O87.SI',
      'N6M.SI', 'QL3.SI', 'OVQ.SI', 'Z97.SI',
    ],
    bondEtfs: [
      'N6M.SI', 'Z97.SI',
    ],
  },

  // ✅ Canada — TSX dividend payers (Phase 1).
  // Trust units (REITs) use DASH format: SRU-UN.TO, not SRU.UN.TO.
  // Verified against probe-canada-results.json (2026-09-18):
  //   .UN.TO variants → HTTP 404
  //   -UN.TO variants → 100–390 dividend payments each, monthly frequency
  ca: {
    // ---------- MONTHLY-PAYING STOCKS (REITs + royalty) ----------
    monthlyStocks: [
      'SRU-UN.TO', 'REI-UN.TO', 'GRT-UN.TO', 'CRT-UN.TO',
      'CRR-UN.TO', 'DIR-UN.TO', 'VITL-UN.TO', 'CHP-UN.TO',
      'FRU.TO', 'WCP.TO', 'DIV.TO',
    ],

    // ---------- QUARTERLY-PAYING DIVIDEND STOCKS ----------
    stocks: [
      // Big Six banks
      'RY.TO', 'TD.TO', 'BNS.TO', 'BMO.TO', 'CM.TO', 'NA.TO',
      // Energy & pipelines
      'ENB.TO', 'TRP.TO', 'PPL.TO', 'SU.TO', 'CNQ.TO',
      // Utilities & telecom
      'FTS.TO', 'CU.TO', 'T.TO', 'BCE.TO',
      // Other
      'EIF.TO',
    ],

    // ---------- QUARTERLY-PAYING DIVIDEND ETFs ----------
    etfs: [
      'PDC.TO', 'DXC.TO',
    ],
  },
};

function getSeedList() {
  const us = [
    ...UNIVERSE.us.dailyPreferred,
    ...UNIVERSE.us.weeklyEtfs,
    ...UNIVERSE.us.monthlyEtfs,
    ...UNIVERSE.us.monthlyStocks,
    ...UNIVERSE.us.stocks,
    ...UNIVERSE.us.etfs,
    ...UNIVERSE.us.bondEtfs,
  ];
  const sg = [
    ...UNIVERSE.sg.stocks,
    ...UNIVERSE.sg.reits,
    ...UNIVERSE.sg.etfs,
  ];
  const ca = [
    ...UNIVERSE.ca.monthlyStocks,
    ...UNIVERSE.ca.stocks,
    ...UNIVERSE.ca.etfs,
  ];
  return {
    us: [...new Set(us)],
    sg: [...new Set(sg)],
    ca: [...new Set(ca)],
  };
}

function getCategoryMap() {
  const map = {};
  for (const ticker of UNIVERSE.us.dailyPreferred) map[ticker] = 'Preferred Stock';
  for (const ticker of UNIVERSE.us.weeklyEtfs) map[ticker] = 'ETF';
  for (const ticker of UNIVERSE.us.monthlyEtfs) map[ticker] = 'ETF';
  for (const ticker of UNIVERSE.us.monthlyStocks) {
    if (['IGA','IGD','IDE','IAE','IHD','HPI','HPF','HPS','PDI','PTY','PCN','PCM','RCS','UTF','ETV','ETB','ETY','BDJ','BME','BOE','BUI','EOI','EOS','ETG','ETJ','ETO'].includes(ticker)) {
      map[ticker] = 'ETF';
    } else {
      map[ticker] = 'Stock';
    }
  }
  for (const ticker of UNIVERSE.us.etfs) map[ticker] = 'ETF';
  for (const ticker of UNIVERSE.us.bondEtfs) map[ticker] = 'Bond ETF';

  for (const ticker of UNIVERSE.sg.reits) map[ticker] = 'REIT';
  for (const ticker of UNIVERSE.sg.etfs) map[ticker] = 'ETF';

  // ✅ Canada — full-symbol keys ('SRU-UN.TO').
  // The classifier tries the full symbol first, so this works.
  // Regex matches both '-' and '.' before UN.TO so it survives
  // a future Yahoo format flip.
  for (const ticker of UNIVERSE.ca.monthlyStocks) {
    map[ticker] = /[-.]UN\.TO$/.test(ticker) ? 'REIT' : 'Stock';
  }
  for (const ticker of UNIVERSE.ca.stocks) map[ticker] = 'Stock';
  for (const ticker of UNIVERSE.ca.etfs) map[ticker] = 'ETF';

  return map;
}

module.exports = { UNIVERSE, getSeedList, getCategoryMap };