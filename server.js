const express = require('express');
const { exec } = require('child_process');
const fs = require('fs').promises;
const axios = require('axios');
const path = require('path');
const FormData = require('form-data');
const fsSync = require('fs');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'FFmpeg API is running',
    timestamp: new Date().toISOString()
  });
});

// Main video processing endpoint
app.post('/process-video', async (req, res) => {
  const startTime = Date.now();
  console.log('🎬 New video processing request received');
  
  try {
    const { videoUrl, includeZoom = true } = req.body;
    
    if (!videoUrl) {
      return res.status(400).json({ error: 'videoUrl is required' });
    }
    
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    }
    
    // Generate unique filenames
    const timestamp = Date.now();
    const inputVideo = `/tmp/input_${timestamp}.mp4`;
    const audioFile = `/tmp/audio_${timestamp}.mp3`;
    const srtFile = `/tmp/captions_${timestamp}.srt`;
    const outputVideo = `/tmp/output_${timestamp}.mp4`;
    
    console.log('📥 Downloading video from HeyGen...');
    // Download video
    const response = await axios.get(videoUrl, { 
      responseType: 'arraybuffer',
      timeout: 60000
    });
    await fs.writeFile(inputVideo, response.data);
    console.log('✅ Video downloaded successfully');
    
    // Extract audio
    console.log('🎵 Extracting audio...');
    await execPromise(`ffmpeg -i ${inputVideo} -vn -acodec libmp3lame -q:a 2 ${audioFile}`);
    console.log('✅ Audio extracted');
    
    // Transcribe with Whisper
    console.log('🎤 Transcribing audio with Whisper...');
    const transcription = await transcribeAudio(audioFile);
    console.log('✅ Transcription complete');
    
    // Convert to SRT with 2-3 word chunks
    console.log('📝 Creating caption file...');
    const srtContent = createSRTFile(transcription);
    await fs.writeFile(srtFile, srtContent);
    console.log('✅ SRT file created');
    
    // Build FFmpeg command with captions and optional zoom
    console.log('🎥 Processing video with captions and effects...');
    let filterComplex = '';
    
    if (includeZoom) {
      // Add random zoom effect (zooms in and out every 10-15 seconds)
      filterComplex = `[0:v]zoompan=z='if(lte(mod(time,12),6),min(1.5,1+(time-floor(time/12)*12)/6*0.5),max(1,1.5-(time-floor(time/12)*12-6)/6*0.5))':d=1:s=1080x1920:fps=30,subtitles=${srtFile}:force_style='FontName=Arial Bold,FontSize=28,PrimaryColour=&H00FFFF,OutlineColour=&H000000,Outline=3,Bold=1,Alignment=2,MarginV=80'[v]`;
    } else {
      filterComplex = `[0:v]subtitles=${srtFile}:force_style='FontName=Arial Bold,FontSize=28,PrimaryColour=&H00FFFF,OutlineColour=&H000000,Outline=3,Bold=1,Alignment=2,MarginV=80'[v]`;
    }
    
    const ffmpegCommand = `ffmpeg -i ${inputVideo} -filter_complex "${filterComplex}" -map "[v]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac ${outputVideo}`;
    
    await execPromise(ffmpegCommand);
    console.log('✅ Video processing complete');
    
    // Read processed video and convert to base64
    console.log('📤 Preparing response...');
    const videoBuffer = await fs.readFile(outputVideo);
    const base64Video = videoBuffer.toString('base64');
    
    // Cleanup temporary files
    console.log('🧹 Cleaning up temporary files...');
    await Promise.all([
      fs.unlink(inputVideo).catch(() => {}),
      fs.unlink(audioFile).catch(() => {}),
      fs.unlink(srtFile).catch(() => {}),
      fs.unlink(outputVideo).catch(() => {})
    ]);
    
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Processing complete in ${processingTime} seconds`);
    
    res.json({
      success: true,
      video: base64Video,
      metadata: {
        processingTimeSeconds: parseFloat(processingTime),
        videoSizeKB: Math.round(videoBuffer.length / 1024),
        captionsAdded: true,
        zoomEffectApplied: includeZoom
      }
    });
    
  } catch (error) {
    console.error('❌ Error processing video:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.toString()
    });
  }
});

// Helper function to execute shell commands as promises
function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

// Transcribe audio using OpenAI Whisper
async function transcribeAudio(audioFilePath) {
  const formData = new FormData();
  formData.append('file', fsSync.createReadStream(audioFilePath));
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');
  
  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      timeout: 60000
    }
  );
  
  return response.data;
}

// Create SRT file with 2-3 word chunks
function createSRTFile(transcription) {
  const words = transcription.words || [];
  let srtContent = '';
  let index = 1;
  
  // Group words into chunks of 2-3 words
  const chunkSize = 3;
  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    
    const startTime = formatTimestamp(chunk[0].start);
    const endTime = formatTimestamp(chunk[chunk.length - 1].end);
    const text = chunk.map(w => w.word).join(' ');
    
    srtContent += `${index}\n`;
    srtContent += `${startTime} --> ${endTime}\n`;
    srtContent += `${text}\n\n`;
    index++;
  }
  
  return srtContent;
}

// Format timestamp for SRT (HH:MM:SS,mmm)
function formatTimestamp(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);
  
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

app.listen(PORT, () => {
  console.log(`🚀 FFmpeg API server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🎬 Process endpoint: POST http://localhost:${PORT}/process-video`);
});
