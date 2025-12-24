const { S3, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const s3 = new S3({ region: 'us-east-1' });

const OUTPUT_BUCKET = 'ffmpeg-processed-videos-lance';
const BROLL_BUCKET = 'ffmpeg-broll-library';

exports.handler = async (event) => {
  console.log('Event received:', JSON.stringify(event));

  // Parse body if it's a Lambda Function URL request
  let params = event;
  if (event.body) {
    try {
      params = JSON.parse(event.body);
    } catch (e) {
      params = event;
    }
  }

  const { videoUrl, includeZoom = true, brollCount = 0 } = params;

  if (!videoUrl) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'videoUrl is required' }),
    };
  }

  const tmpDir = '/tmp';
  const inputVideo = path.join(tmpDir, 'input.mp4');
  const outputVideo = path.join(tmpDir, 'output.mp4');
  const audioFile = path.join(tmpDir, 'audio.mp3');
  const srtFile = path.join(tmpDir, 'subtitles.srt');

  try {
    // Step 1: Download input video
    console.log('Downloading input video from:', videoUrl);
    const response = await axios({
      method: 'get',
      url: videoUrl,
      responseType: 'stream',
    });

    const writer = fs.createWriteStream(inputVideo);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    console.log('Video downloaded successfully');

    // Step 2: Extract audio for transcription
    console.log('Extracting audio...');
    execSync(`ffmpeg -i ${inputVideo} -q:a 0 -map a ${audioFile} -y`, { stdio: 'inherit' });

    // Step 3: Transcribe with OpenAI Whisper
    console.log('Transcribing audio with Whisper...');
    const transcription = await transcribeWithWhisper(audioFile);
    console.log('Transcription completed');

    // Step 4: Create SRT file from transcription
    console.log('Creating SRT file...');
    createSRTFile(transcription, srtFile);

    // Step 5: Handle B-roll if requested
    let videoForCaptions = inputVideo;
    
    if (brollCount > 0) {
      console.log(`Processing with ${brollCount} B-roll clips...`);
      const videoDuration = getVideoDuration(inputVideo);
      console.log(`Avatar video duration: ${videoDuration}s`);
      
      // Extract original audio
      const originalAudio = path.join(tmpDir, 'original_audio.aac');
      execSync(`ffmpeg -i ${inputVideo} -vn -c:a copy ${originalAudio} -y`, { stdio: 'inherit' });
      console.log('Extracted original audio');
      
      // Get random B-roll clips
      const brollClips = await getRandomBrollClips(brollCount, tmpDir);
      console.log(`Downloaded ${brollClips.length} B-roll clips`);
      
      // Calculate where to insert B-roll (in original timeline)
      const insertionPoints = calculateInsertionPoints(videoDuration, brollCount);
      console.log('B-roll insertion points:', insertionPoints);
      
      // Build video segments (B-roll REPLACES avatar at those points)
      const videoSegments = await buildAndExtractVideoSegments(
        inputVideo,
        brollClips,
        insertionPoints,
        videoDuration,
        tmpDir
      );
      console.log(`Created ${videoSegments.length} video segment files`);
      
      // Stitch video segments (video-only)
      const stitchedVideoOnly = path.join(tmpDir, 'stitched_video.mp4');
      await stitchVideoSegments(videoSegments, stitchedVideoOnly, tmpDir);
      console.log('Video segments stitched');
      
      // Add original audio back
      videoForCaptions = path.join(tmpDir, 'video_with_audio.mp4');
      execSync(
        `ffmpeg -i ${stitchedVideoOnly} -i ${originalAudio} -c:v copy -c:a aac -b:a 128k -shortest ${videoForCaptions} -y`,
        { stdio: 'inherit' }
      );
      console.log('Added original audio - duration maintained');
    }

    // Step 6: Add captions and zoom to final video
    console.log('Adding captions and zoom effects...');
    let filterComplex;

    if (includeZoom) {
      // Dynamic zoom: 0.3s in → 4.7s hold → 0.3s out → 4.7s normal (10s cycle)
      // Horizontal: 55% right / 45% left
      filterComplex = `[0:v]zoompan=z='if(lt(mod(time,10),0.3), 1+(mod(time,10)/0.3)*0.15, if(lt(mod(time,10),5), 1.15, if(lt(mod(time,10),5.3), 1.15-((mod(time,10)-5)/0.3)*0.15, 1)))':x='if(lt(mod(time,30),10), iw/2-(iw/zoom/2), if(lt(mod(time,30),20), iw*0.55-(iw/zoom/2), iw*0.45-(iw/zoom/2)))':y='ih/3-(ih/zoom/2)':d=1:s=720x1280,subtitles=${srtFile}:force_style='FontName=Arial Bold,FontSize=18,PrimaryColour=&H00FFFF,OutlineColour=&H000000,Outline=3,Bold=1,Alignment=2,MarginV=55,MarginL=40,MarginR=40'[v]`;
    } else {
      filterComplex = `[0:v]subtitles=${srtFile}:force_style='FontName=Arial Bold,FontSize=18,PrimaryColour=&H00FFFF,OutlineColour=&H000000,Outline=3,Bold=1,Alignment=2,MarginV=55,MarginL=40,MarginR=40'[v]`;
    }

    const ffmpegCommand = `ffmpeg -i ${videoForCaptions} -filter_complex "${filterComplex}" -map "[v]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a copy ${outputVideo}`;
    
    console.log('Running FFmpeg command...');
    execSync(ffmpegCommand, { stdio: 'inherit' });
    console.log('FFmpeg processing completed');

    // Step 7: Upload to S3
    console.log('Uploading processed video to S3...');
    const outputKey = `processed-${Date.now()}.mp4`;
    const fileContent = fs.readFileSync(outputVideo);

    await s3.putObject({
      Bucket: OUTPUT_BUCKET,
      Key: outputKey,
      Body: fileContent,
      ContentType: 'video/mp4',
    });

    // Generate pre-signed URL (valid for 24 hours)
    const command = new GetObjectCommand({
      Bucket: OUTPUT_BUCKET,
      Key: outputKey,
    });
    const s3Url = await getSignedUrl(s3, command, { expiresIn: 86400 });
    console.log('Upload successful, generated pre-signed URL');

    // Cleanup
    console.log('Cleaning up temporary files...');
    [inputVideo, outputVideo, audioFile, srtFile].forEach((file) => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });

    // Cleanup B-roll files
    if (brollCount > 0) {
      const tmpFiles = fs.readdirSync(tmpDir);
      tmpFiles.forEach(file => {
        if (file.startsWith('broll_') || file.startsWith('segment_') || 
            file.startsWith('stitched_') || file.startsWith('original_') ||
            file.startsWith('video_with_') || file === 'concat.txt') {
          const filePath = path.join(tmpDir, file);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ videoUrl: s3Url }),
    };
  } catch (error) {
    console.error('Error processing video:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

// Get random B-roll clips from S3
async function getRandomBrollClips(count, tmpDir) {
  console.log(`Fetching random ${count} clips from ${BROLL_BUCKET}...`);
  
  const listResponse = await s3.listObjectsV2({
    Bucket: BROLL_BUCKET,
  });

  if (!listResponse.Contents || listResponse.Contents.length === 0) {
    throw new Error('No B-roll clips found in S3 bucket');
  }

  const videoFiles = listResponse.Contents.filter(obj => 
    obj.Key.endsWith('.mp4') || obj.Key.endsWith('.mov')
  );

  console.log(`Found ${videoFiles.length} video files in B-roll library`);

  const shuffled = videoFiles.sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, Math.min(count, videoFiles.length));

  const clips = [];
  for (let i = 0; i < selected.length; i++) {
    const s3Object = selected[i];
    const localPath = path.join(tmpDir, `broll_${i}.mp4`);

    console.log(`Downloading B-roll clip: ${s3Object.Key}`);
    
    const getResponse = await s3.getObject({
      Bucket: BROLL_BUCKET,
      Key: s3Object.Key,
    });

    const chunks = [];
    for await (const chunk of getResponse.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(localPath, buffer);

    const duration = getVideoDuration(localPath);
    
    clips.push({
      localPath,
      duration,
      key: s3Object.Key,
    });
  }

  return clips;
}

// Calculate where to insert B-roll in the timeline
function calculateInsertionPoints(totalDuration, count) {
  const points = [];
  const startBuffer = 3; // Avoid first 3 seconds
  const endBuffer = 3;   // Avoid last 3 seconds
  const usableDuration = totalDuration - startBuffer - endBuffer;
  
  const interval = usableDuration / (count + 1);
  
  for (let i = 1; i <= count; i++) {
    const point = startBuffer + (interval * i);
    points.push(point);
  }
  
  return points;
}

// Build and extract video segments (B-roll REPLACES avatar portions)
async function buildAndExtractVideoSegments(avatarVideo, brollClips, insertionPoints, totalDuration, tmpDir) {
  const segmentFiles = [];
  const maxBrollDuration = 4; // Each B-roll clip max 4 seconds
  
  let currentTime = 0;
  
  for (let i = 0; i < insertionPoints.length; i++) {
    const insertAt = insertionPoints[i];
    const broll = brollClips[i];
    const brollDuration = Math.min(broll.duration, maxBrollDuration);
    
    // Avatar segment BEFORE B-roll (video-only)
    const avatarDuration = insertAt - currentTime;
    if (avatarDuration > 0) {
      const segPath = path.join(tmpDir, `segment_${segmentFiles.length}.mp4`);
      console.log(`Extract avatar: ${currentTime}s to ${insertAt}s (${avatarDuration}s)`);
      execSync(
        `ffmpeg -ss ${currentTime} -i ${avatarVideo} -t ${avatarDuration} -an -c:v libx264 -preset ultrafast -crf 23 ${segPath} -y`,
        { stdio: 'inherit' }
      );
      segmentFiles.push(segPath);
    }
    
    // B-roll segment (video-only, replaces avatar)
    const brollPath = path.join(tmpDir, `segment_${segmentFiles.length}.mp4`);
    console.log(`B-roll ${i}: ${brollDuration}s (replaces avatar ${insertAt}s-${insertAt + brollDuration}s)`);
    execSync(
      `ffmpeg -i ${broll.localPath} -t ${brollDuration} -an -c:v libx264 -preset ultrafast -crf 23 -s 720x1280 ${brollPath} -y`,
      { stdio: 'inherit' }
    );
    segmentFiles.push(brollPath);
    
    // Advance timeline by B-roll duration (skip that portion of avatar)
    currentTime = insertAt + brollDuration;
  }
  
  // Final avatar segment AFTER last B-roll (video-only)
  const remainingDuration = totalDuration - currentTime;
  if (remainingDuration > 0) {
    const segPath = path.join(tmpDir, `segment_${segmentFiles.length}.mp4`);
    console.log(`Extract final avatar: ${currentTime}s to end (${remainingDuration}s)`);
    execSync(
      `ffmpeg -ss ${currentTime} -i ${avatarVideo} -t ${remainingDuration} -an -c:v libx264 -preset ultrafast -crf 23 ${segPath} -y`,
      { stdio: 'inherit' }
    );
    segmentFiles.push(segPath);
  }
  
  return segmentFiles;
}

// Stitch video-only segments
async function stitchVideoSegments(segmentFiles, outputPath, tmpDir) {
  const concatFile = path.join(tmpDir, 'concat.txt');
  const concatContent = segmentFiles.map(file => `file '${file}'`).join('\n');
  fs.writeFileSync(concatFile, concatContent);

  console.log('Concatenating video segments...');
  execSync(
    `ffmpeg -f concat -safe 0 -i ${concatFile} -c:v libx264 -preset fast -crf 23 ${outputPath} -y`,
    { stdio: 'inherit' }
  );
  
  console.log('Video stitching complete');
}

// Get video duration in seconds
function getVideoDuration(videoPath) {
  const output = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${videoPath}`
  ).toString();
  return parseFloat(output.trim());
}

// Transcribe audio using OpenAI Whisper API
async function transcribeWithWhisper(audioFile) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(audioFile));
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');

  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...formData.getHeaders(),
    },
  });

  return response.data;
}

// Create SRT file with 3-word chunks
function createSRTFile(transcription, outputFile) {
  const words = transcription.words;
  const srtEntries = [];
  let index = 1;

  for (let i = 0; i < words.length; i += 3) {
    const chunk = words.slice(i, i + 3);
    const text = chunk.map((w) => w.word).join(' ');
    const start = formatTimestamp(chunk[0].start);
    const end = formatTimestamp(chunk[chunk.length - 1].end);

    srtEntries.push(`${index}\n${start} --> ${end}\n${text}\n`);
    index++;
  }

  fs.writeFileSync(outputFile, srtEntries.join('\n'));
}

// Format timestamp for SRT (HH:MM:SS,mmm)
function formatTimestamp(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}
