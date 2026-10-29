/* upload-progress-patch.js
   Reusable upload progress & concurrent upload engine with retry controls for Prostarm suite.
*/
(function(window){
  'use strict';

  /**
   * Uploads a payload using XMLHttpRequest with real byte-level progress reporting and timeout handling.
   * @param {string} url - Target endpoint URL.
   * @param {object|string} payload - JSON string or object payload to send.
   * @param {function} onProgress - Callback (pct, loaded, total).
   * @param {number} timeoutMs - Timeout in milliseconds.
   * @returns {Promise<object>} - Parsed response or raw text.
   */
  function uploadWithProgress(url, payload, onProgress, timeoutMs) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (window.API_KEY) xhr.setRequestHeader('X-API-Key', window.API_KEY);
      xhr.timeout = timeoutMs || 120000;

      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) {
            const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
            onProgress(pct, e.loaded, e.total);
          }
        };
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (onProgress) onProgress(100);
          try {
            resolve(JSON.parse(xhr.responseText || '{}'));
          } catch(e) {
            resolve({ raw: xhr.responseText });
          }
        } else {
          let errDetail = '';
          try {
            const errObj = JSON.parse(xhr.responseText || '{}');
            errDetail = errObj.message || errObj.error || xhr.responseText;
          } catch (e) {
            errDetail = (xhr.responseText || '').slice(0, 200);
          }
          reject(new Error(`HTTP ${xhr.status}: ${errDetail || 'Upload failed'}`));
        }
      };

      xhr.onerror = () => reject(new Error('Network connectivity error during upload'));
      xhr.ontimeout = () => reject(new Error('Upload timed out after ' + Math.round((timeoutMs || 120000)/1000) + 's'));
      xhr.onabort = () => reject(new Error('Upload aborted by user'));
      xhr.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  }

  /**
   * Queue manager for concurrent file uploads with individual item retry controls.
   */
  class ConcurrentUploadManager {
    constructor(options = {}) {
      this.maxConcurrent = options.maxConcurrent || 2;
      this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 2;
      this.retryDelayMs = options.retryDelayMs || 1500;
      this.timeoutMs = options.timeoutMs || 120000;
      this.queue = [];
      this.activeCount = 0;
      this.callbacks = {
        onItemProgress: options.onItemProgress || (() => {}),
        onItemComplete: options.onItemComplete || (() => {}),
        onItemError: options.onItemError || (() => {}),
        onItemRetry: options.onItemRetry || (() => {}),
        onBatchComplete: options.onBatchComplete || (() => {}),
        onQueueChange: options.onQueueChange || (() => {})
      };
    }

    /**
     * Adds items to the queue.
     * @param {Array<{id, name, url, payload, retriesLeft}>} items 
     */
    addItems(items) {
      const formatted = items.map(item => ({
        id: item.id || 'DOC_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: item.name || 'Document',
        url: item.url,
        payload: item.payload,
        status: 'queued', // queued | uploading | success | error | paused
        progress: 0,
        error: null,
        attempts: 0,
        retriesLeft: item.retriesLeft !== undefined ? item.retriesLeft : this.maxRetries,
        meta: item.meta || {}
      }));

      this.queue.push(...formatted);
      this.callbacks.onQueueChange(this.getQueueSnapshot());
      this._drain();
      return formatted.map(f => f.id);
    }

    /**
     * Retry a specific failed item by ID.
     */
    retryItem(id) {
      const item = this.queue.find(q => q.id === id);
      if (!item) return false;
      if (item.status === 'uploading') return false;

      item.status = 'queued';
      item.error = null;
      item.progress = 0;
      item.retriesLeft = this.maxRetries;
      this.callbacks.onQueueChange(this.getQueueSnapshot());
      this._drain();
      return true;
    }

    /**
     * Retry all failed or paused items in the queue.
     */
    retryAllFailed() {
      let count = 0;
      this.queue.forEach(item => {
        if (item.status === 'error') {
          item.status = 'queued';
          item.error = null;
          item.progress = 0;
          item.retriesLeft = this.maxRetries;
          count++;
        }
      });

      if (count > 0) {
        this.callbacks.onQueueChange(this.getQueueSnapshot());
        this._drain();
      }
      return count;
    }

    /**
     * Clear finished or failed items from the queue.
     */
    clearCompleted() {
      this.queue = this.queue.filter(q => q.status !== 'success');
      this.callbacks.onQueueChange(this.getQueueSnapshot());
    }

    /**
     * Remove an item from the queue by ID.
     */
    removeItem(id) {
      const idx = this.queue.findIndex(q => q.id === id);
      if (idx !== -1) {
        this.queue.splice(idx, 1);
        this.callbacks.onQueueChange(this.getQueueSnapshot());
        return true;
      }
      return false;
    }

    /**
     * Returns snapshot of the current queue state.
     */
    getQueueSnapshot() {
      return {
        total: this.queue.length,
        uploading: this.queue.filter(q => q.status === 'uploading').length,
        queued: this.queue.filter(q => q.status === 'queued').length,
        success: this.queue.filter(q => q.status === 'success').length,
        error: this.queue.filter(q => q.status === 'error').length,
        items: this.queue.map(q => ({ ...q }))
      };
    }

    /**
     * Internal processor for dispatching queue items according to concurrency limits.
     */
    _drain() {
      while (this.activeCount < this.maxConcurrent) {
        const nextItem = this.queue.find(q => q.status === 'queued');
        if (!nextItem) break;

        this.activeCount++;
        nextItem.status = 'uploading';
        nextItem.attempts++;
        this.callbacks.onQueueChange(this.getQueueSnapshot());

        this._executeUpload(nextItem);
      }

      if (this.activeCount === 0 && this.queue.every(q => q.status === 'success' || q.status === 'error')) {
        this.callbacks.onBatchComplete(this.getQueueSnapshot());
      }
    }

    async _executeUpload(item) {
      try {
        const result = await uploadWithProgress(
          item.url,
          item.payload,
          (pct) => {
            item.progress = pct;
            this.callbacks.onItemProgress(item.id, pct, item);
          },
          this.timeoutMs
        );

        item.status = 'success';
        item.progress = 100;
        item.result = result;
        this.callbacks.onItemComplete(item.id, result, item);
      } catch (err) {
        item.error = err.message || 'Upload failed';

        // Automatic retry logic if retries remain
        if (item.retriesLeft > 0) {
          item.retriesLeft--;
          item.status = 'queued';
          this.callbacks.onItemRetry(item.id, item.retriesLeft, err, item);
          
          // Back-off wait before re-queueing
          await new Promise(r => setTimeout(r, this.retryDelayMs));
        } else {
          item.status = 'error';
          this.callbacks.onItemError(item.id, err, item);
        }
      } finally {
        this.activeCount--;
        this.callbacks.onQueueChange(this.getQueueSnapshot());
        this._drain();
      }
    }
  }

  window.ProstarmUploader = {
    uploadWithProgress,
    ConcurrentUploadManager,
    createUploadManager: (options) => new ConcurrentUploadManager(options)
  };
})(window);
