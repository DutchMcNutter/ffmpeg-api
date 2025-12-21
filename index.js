const { exec } = require('child_process');
const fs = require('fs').promises;
const axios = require('axios');
const FormData = require('form-data');
const fsSync = require('fs');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const S3_BUCKET = 'ffmpeg-processed-videos-lance';
const s3Client = new S3Client({ region: 'us-east-1' });

// Lambda handler function
exports.handler = async (event) => {
  const startTime = Date.now();
  console.log('🎬 New video processing request received');
  
  try {
    // Parse request body (Lambda passes it as string)
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body || {};
    }
    
    // Handle health check
    if (event.rawPath === '/health' || event.path === '/health') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          status: 'ok', 
          message: 'FFmpeg Lambda is running',
          timestamp: new Date().toISOString()
        })
      };
    }
    
    const { videoUrl, includeZoom = true } = body;
    
    if (!videoUrl) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'videoUrl is required' })
      };
    }
    
    if (!OPENAI_API_KEY) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'OPENAI_API_KEY not configured' })
      };
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
  // Dynamic zoom with variety: 1s in → 4s hold → 1s out → 4s normal (10s cycle)
  // 30s pattern: 0-10s center, 10-20s right, 20-30s left, then repeats
  filterComplex = `[0:v]zoompan=z='if(lt(mod(time,10),1), 1+(mod(time,10)/1)*0.15, if(lt(mod(time,10),5), 1.15, if(lt(mod(time,10),6), 1.15-((mod(time,10)-5)/1)*0.15, 1)))':x='if(lt(mod(time,30),10), iw/2-(iw/zoom/2), if(lt(mod(time,30),20), iw*0.65-(iw/zoom/2), iw*0.35-(iw/zoom/2)))':y='ih/3-(ih/zoom/2)':d=1:s=720x1280,subtitles=${srtFile}:force_style='FontName=Arial Bold,FontSize=18,PrimaryColour=&H00FFFF,OutlineColour=&H000000,Outline=3,Bold=1,Alignment=2,MarginV=55,MarginL=40,MarginR=40'[v]`;
} else {
  filterComplex = `[0:v]subtitles=${srtFile}:force_style='FontName=Arial Bold,FontSize=18,PrimaryColour=&H00FFFF,OutlineColour=&H000000,Outline=3,Bold=1,Alignment=2,MarginV=55,MarginL=40,MarginR=40'[v]`;
}

const ffmpegCommand = `ffmpeg -i ${inputVideo} -filter_complex "${filterComplex}" -map "[v]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a copy ${outputVideo}`;
    
    await execPromise(ffmpegCommand);
    console.log('✅ Video processing complete');
    
    // Upload to S3
    console.log('☁️ Uploading to S3...');
    const videoBuffer = await fs.readFile(outputVideo);
    const s3Key = `processed/${timestamp}.mp4`;
    
    const uploadCommand = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: videoBuffer,
      ContentType: 'video/mp4'
    });
    
    await s3Client.send(uploadCommand);
    console.log('✅ Uploaded to S3');
    
    // Generate presigned download URL (valid for 1 hour)
    console.log('🔗 Generating download URL...');
    const downloadUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key
      }),
      { expiresIn: 3600 } // 1 hour
    );
    
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
    
    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        videoUrl: downloadUrl,
        metadata: {
          processingTimeSeconds: parseFloat(processingTime),
          videoSizeKB: Math.round(videoBuffer.length / 1024),
          captionsAdded: true,
          zoomEffectApplied: includeZoom,
          s3Key: s3Key,
          expiresIn: '1 hour'
        }
      })
    };
    
  } catch (error) {
    console.error('❌ Error processing video:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: error.message,
        details: error.toString()
      })
    };
  }
};

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
