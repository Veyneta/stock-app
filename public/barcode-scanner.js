// Barcode Scanner using ZXing (works on all browsers including Safari)
class BarcodeScanner {
  constructor() {
    this.stream = null;
    this.scanning = false;
    this.onDetect = null;
    this.codeReader = null;
  }

  async start(videoElement, onDetect) {
    this.onDetect = onDetect;
    
    try {
      // Check if ZXing library is loaded
      if (typeof ZXing === 'undefined') {
        throw new Error('ZXing library not loaded');
      }

      // Create ZXing reader
      this.codeReader = new ZXing.BrowserMultiFormatReader();
      
      // Get available video devices
      const videoInputDevices = await this.codeReader.listVideoInputDevices();
      
      if (videoInputDevices.length === 0) {
        throw new Error('No camera found');
      }

      // Try to find back camera (for mobile)
      let selectedDeviceId = videoInputDevices[0].deviceId;
      for (const device of videoInputDevices) {
        if (device.label.toLowerCase().includes('back') || 
            device.label.toLowerCase().includes('rear') ||
            device.label.toLowerCase().includes('environment')) {
          selectedDeviceId = device.deviceId;
          break;
        }
      }

      this.scanning = true;

      // Start continuous scanning
      this.codeReader.decodeFromVideoDevice(
        selectedDeviceId,
        videoElement,
        (result, err) => {
          if (result && this.scanning) {
            const barcode = result.getText();
            this.onDetect(barcode);
            this.stop();
          }
          // Continue scanning on error (no barcode detected yet)
        }
      );
      
      return true;
    } catch (error) {
      console.error('Camera access error:', error);
      alert('ไม่สามารถเข้าถึงกล้องได้ กรุณาอนุญาตการใช้กล้องในเบราว์เซอร์');
      return false;
    }
  }

  stop() {
    this.scanning = false;
    if (this.codeReader) {
      this.codeReader.reset();
      this.codeReader = null;
    }
  }
}

// Scanner Modal Controller
const ScannerModal = {
  scanner: null,
  modal: null,
  video: null,
  onScan: null,

  init() {
    // Create modal HTML
    const modalHTML = `
      <div id="scanner-modal" class="scanner-modal" style="display: none;">
        <div class="scanner-overlay"></div>
        <div class="scanner-content">
          <div class="scanner-header">
            <h3>สแกนบาร์โค้ด</h3>
            <button class="scanner-close" onclick="ScannerModal.close()">✕</button>
          </div>
          <div class="scanner-body">
            <video id="scanner-video" autoplay playsinline></video>
            <div class="scanner-guide">
              <div class="scanner-line"></div>
            </div>
            <p class="scanner-hint">วางบาร์โค้ดให้อยู่ในกรอบ</p>
          </div>
          <div class="scanner-actions">
            <button class="btn btn-ghost" onclick="ScannerModal.manualInput()">พิมพ์เอง</button>
            <button class="btn btn-ghost" onclick="ScannerModal.close()">ยกเลิก</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHTML);
    this.modal = document.getElementById('scanner-modal');
    this.video = document.getElementById('scanner-video');
    this.scanner = new BarcodeScanner();
  },

  open(callback) {
    if (!this.modal) this.init();
    
    this.onScan = callback;
    this.modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    
    // Check if ZXing is loaded
    if (typeof ZXing === 'undefined') {
      const fallback = confirm(
        'ไม่สามารถโหลดไลบรารี่สแกนบาร์โค้ดได้\n\n' +
        'ต้องการพิมพ์รหัสเองหรือไม่?'
      );
      
      if (fallback) {
        this.close();
        this.manualInput();
      } else {
        this.close();
      }
      return;
    }
    
    this.scanner.start(this.video, (barcode) => {
      this.handleScan(barcode);
    });
  },

  close() {
    if (this.scanner) {
      this.scanner.stop();
    }
    if (this.modal) {
      this.modal.style.display = 'none';
    }
    document.body.style.overflow = 'auto';
  },

  handleScan(barcode) {
    if (this.onScan) {
      this.onScan(barcode);
    }
    this.close();
  },

  manualInput() {
    const barcode = prompt('กรุณาใส่รหัสบาร์โค้ด:');
    if (barcode && barcode.trim()) {
      this.handleScan(barcode.trim());
    }
  }
};

// Helper function to open scanner
function openBarcodeScanner(callback) {
  ScannerModal.open(callback);
}
