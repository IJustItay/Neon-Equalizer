export class SquiglinkAPI {
  constructor() {
    this.phoneBook = [];
    this.baseUrl = '';
  }

  async loadDatabase(dataFolderUrl) {
    this.baseUrl = dataFolderUrl;
    const url = `${this.baseUrl}/phone_book.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch phone_book.json');
    this.phoneBook = await res.json();
    return this.phoneBook;
  }

  async fetchMeasurement(brandName, fileName) {
    // Build encoded URLs for L, R, and fallback
    const encFile = encodeURIComponent(fileName);
    
    let lData = null;
    let rData = null;
    let fallbackData = null;

    try {
      const lUrl = `${this.baseUrl}/${encFile}%20L.txt`;
      lData = await this._fetchAndParseData(lUrl);
    } catch(e) {}
    
    try {
      const rUrl = `${this.baseUrl}/${encFile}%20R.txt`;
      rData = await this._fetchAndParseData(rUrl);
    } catch(e) {}

    if (!lData && !rData) {
      try {
        const fallUrl = `${this.baseUrl}/${encFile}.txt`;
        fallbackData = await this._fetchAndParseData(fallUrl);
      } catch(e) {
        throw new Error(`Measurements not found for: ${fileName}`);
      }
      return fallbackData;
    }

    if (lData && rData) {
      return this._averageData(lData, rData);
    }

    return lData || rData;
  }

  async fetchTarget(targetFileName) {
    const url = `${this.baseUrl}/${encodeURIComponent(targetFileName)}`;
    return await this._fetchAndParseData(url);
  }

  async _fetchAndParseData(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('File not found');
    const text = await res.text();
    return this._parseTXT(text);
  }

  _parseTXT(text) {
    const lines = text.split('\n');
    const freq = [];
    const spl = [];
    
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('*')) continue;
      
      const parts = line.split(/[\s\t,]+/);
      if (parts.length >= 2) {
        const f = parseFloat(parts[0]);
        const s = parseFloat(parts[1]);
        if (!isNaN(f) && !isNaN(s)) {
          freq.push(f);
          spl.push(s);
        }
      }
    }
    
    return { freq, spl };
  }

  _averageData(lData, rData) {
    const minLen = Math.min(lData.freq.length, rData.freq.length);
    const freq = [];
    const spl = [];
    
    for (let i = 0; i < minLen; i++) {
        freq.push(lData.freq[i]);
        spl.push((lData.spl[i] + rData.spl[i]) / 2.0);
    }
    return { freq, spl };
  }
}
