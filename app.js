const express = require('express');
const ytdl = require('@distube/ytdl-core');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const cors = require('cors');

const app = express();
app.use(cors());
const progressMap = new Map();
const downloadMap = new Map();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

// Parse URL-encoded bodies (for form data)
app.use(express.urlencoded({ extended: true }));

// Route for homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Route for downloading YouTube video with merging video and audio
app.get('/download', async (req, res) => {
  const { url, quality, type, id } = req.query;

  if (!url || !ytdl.validateURL(url)) {
    return res.status(400).send('Invalid YouTube URL');
  }

  if (!id) {
    return res.status(400).send('Missing request ID');
  }

  progressMap.set(id, { video: 0, audio: 0, merge: 0, status: 'starting' });

  try {
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^a-zA-Z0-9]/g, '_'); // Sanitize title for filename

    const qualHeight = parseInt(quality) || 1080;

    let videoFormat, audioFormat;

    if (type === 'video') {
      const videoFormats = ytdl.filterFormats(info.formats, 'videoonly').filter(f => f.height <= qualHeight).sort((a, b) => (b.height || 0) - (a.height || 0));
      videoFormat = videoFormats[0];
      const audioFormats = ytdl.filterFormats(info.formats, 'audioonly').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      audioFormat = audioFormats[0];
      if (!videoFormat || !audioFormat) {
        progressMap.get(id).status = 'error';
        return res.status(400).send('Could not find suitable formats');
      }
    } else {
      const audioFormats = ytdl.filterFormats(info.formats, 'audioonly').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      audioFormat = audioFormats[0];
      if (!audioFormat) {
        progressMap.get(id).status = 'error';
        return res.status(400).send('Could not find suitable audio format');
      }
    }

    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    const timestamp = Date.now();
    let videoPath, audioPath, outputPath;

    if (type === 'video') {
      videoPath = path.join(tempDir, `${timestamp}_video.mp4`);
      audioPath = path.join(tempDir, `${timestamp}_audio.m4a`);
      outputPath = path.join(tempDir, `${timestamp}_output.mp4`);
    } else {
      audioPath = path.join(tempDir, `${timestamp}_audio.m4a`);
      outputPath = audioPath;
    }

    let downloadsCompleted = 0;

    const onDownloadComplete = () => {
      downloadsCompleted++;
      if ((type === 'video' && downloadsCompleted === 2) || (type === 'audio' && downloadsCompleted === 1)) {
        if (type === 'video') {
          progressMap.get(id).merge = 50;
          exec(`ffmpeg -i "${videoPath}" -i "${audioPath}" -c copy "${outputPath}"`, (error, stdout, stderr) => {
            if (error) {
              console.error('FFmpeg merge error:', error);
              progressMap.get(id).status = 'error';
              cleanup();
              return;
            }
            progressMap.get(id).merge = 100;
            progressMap.get(id).status = 'complete';
            downloadMap.set(id, { path: outputPath, title, type });
            try {
              fs.unlinkSync(videoPath);
              fs.unlinkSync(audioPath);
            } catch (e) {}
          });
        } else {
          progressMap.get(id).status = 'complete';
          downloadMap.set(id, { path: outputPath, title, type });
        }
      }
    };

    const cleanup = () => {
      try {
        if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch (err) {
        console.error('Cleanup error:', err);
      }
      progressMap.delete(id);
    };

    if (type === 'video') {
      const videoWriteStream = fs.createWriteStream(videoPath);
      const videoStream = ytdl.downloadFromInfo(info, { format: videoFormat });
      let videoBytes = 0;
      const videoTotal = videoFormat.contentLength ? parseInt(videoFormat.contentLength) : 1;
      videoStream.on('data', (chunk) => {
        videoBytes += chunk.length;
        progressMap.get(id).video = Math.min((videoBytes / videoTotal) * 100, 100);
      });
      videoStream.pipe(videoWriteStream);
      videoWriteStream.on('finish', onDownloadComplete);
      videoWriteStream.on('error', (err) => {
        console.error('Video download error:', err);
        progressMap.get(id).status = 'error';
        cleanup();
      });
    }

    const audioWriteStream = fs.createWriteStream(audioPath);
    const audioStream = ytdl.downloadFromInfo(info, { format: audioFormat });
    let audioBytes = 0;
    const audioTotal = audioFormat.contentLength ? parseInt(audioFormat.contentLength) : 1;
    audioStream.on('data', (chunk) => {
      audioBytes += chunk.length;
      progressMap.get(id).audio = Math.min((audioBytes / audioTotal) * 100, 100);
    });
    audioStream.pipe(audioWriteStream);
    audioWriteStream.on('finish', onDownloadComplete);
    audioWriteStream.on('error', (err) => {
      console.error('Audio download error:', err);
      progressMap.get(id).status = 'error';
      cleanup();
    });

    res.json({ message: 'Download started', id });

  } catch (error) {
    console.error('Error:', error);
    progressMap.get(id).status = 'error';
    res.status(500).send('Error starting download');
  }
});

// Route for progress
app.get('/progress', (req, res) => {
  const id = req.query.id;
  const progress = progressMap.get(id);
  if (progress) {
    res.json(progress);
  } else {
    res.status(404).json({ error: 'Progress not found' });
  }
});

// Route for downloading the file
app.get('/downloadfile', (req, res) => {
  const id = req.query.id;
  const data = downloadMap.get(id);
  if (data) {
    const filename = data.title + (data.type === 'video' ? '.mp4' : '.m4a');
    res.download(data.path, filename, (err) => {
      if (!err) {
        try {
          fs.unlinkSync(data.path);
        } catch (e) {
          console.error('Cleanup error:', e);
        }
        downloadMap.delete(id);
        progressMap.delete(id);
      }
    });
  } else {
    res.status(404).send('File not found');
  }
});

// Check ffmpeg availability on server start
exec('ffmpeg -version', (error, stdout, stderr) => {
  if (error) {
    console.error('FFmpeg is not installed or not found in PATH. Please install ffmpeg and add it to your system PATH.');
  } else {
    console.log('FFmpeg is available.');
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
