const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { SupabaseVectorStore, SupabaseFilterRPCCall} = require('@langchain/community/vectorstores/supabase');
const { OllamaEmbeddings } = require("@langchain/community/embeddings/ollama");
const { Ollama } = require("@langchain/community/llms/ollama");
const {OpenAI}=require("openai")
require('dotenv').config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const authToken = process.env.AUTH_TOKEN;
const apiEndpoint = process.env.API_ENDPOINT;
const timestampThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000).getTime(); // Threshold timestamp

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseKey) throw new Error(`Expected SUPABASE_SERVICE_ROLE_KEY`);

const url = process.env.SUPABASE_URL;
if (!url) throw new Error(`Expected env var SUPABASE_URL`);

const client = createClient(url, supabaseKey)

let i=1;
const docsInOutline=[];

async function fetchData(authToken, apiEndpoint, limit, offset) {
    let data = JSON.stringify({
        "offset": offset,
        "limit": limit,
        "sort": "updatedAt",
        "direction": "DESC"
    });

    let config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: apiEndpoint,
        headers: { 
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${authToken}`
        },
        data: data
    };

    try {
        const response = await axios.request(config);
        return response.data;
    } catch (error) {
        console.error('Error hitting the API:', error);
        return null;
    }
}

async function fetchAllData(authToken, apiEndpoint) {
    const limit = 100;
    let offset = 0;
    let allData = [];

    while (true) {
        const response = await fetchData(authToken, apiEndpoint, limit, offset);

        if (!response || !response.data || response.data.length === 0) {
            break;
        }

        allData = allData.concat(response.data);
        offset += limit;
    }
    return allData;
}

async function deleteEntriesWithID(id) {
    try {
        const { error } = await client
                        .from('lohumoutline')
                        .delete()
                        .eq('metadata->>docId', id)

        if (error) {
            throw error;
        }
        console.log(`Deleted entries with ID: ${id}`);
    } catch (error) {
        console.error('Error deleting entries:', error.message);
    }
}

function chunkText(text, chunkSize) {
    // Assuming paragraphs are separated by double newlines
    const paragraphs = text.split('\n\n');
    const chunks = [];
    for (let i = 0; i < paragraphs.length; i += chunkSize) {
      chunks.push(paragraphs.slice(i, i + chunkSize));
    }
    return chunks;
  }

async function processBatch(batch) {
    try{
    const itemCreatedAt = new Date(batch.createdAt).getTime();
    const itemUpdatedAt = new Date(batch.updatedAt).getTime();
    docsInOutline.push(batch.id);

    if ((itemCreatedAt > timestampThreshold || itemUpdatedAt > timestampThreshold) && batch.text) {
        const id = batch.id;
        const chunks = chunkText(batch.text, 10);
        let j = 0;
        let docs = [];

        for (const chunk of chunks) { 
            const millisecondsSinceEpoch = Date.now();
            const metadata = { docId: batch.id, chunkNo: j, url: batch.url, urlId: batch.urlId,source:'outline.lohum.com' }; // Adjust metadata as needed
            j +=1;
            const embedding=await openai.embeddings.create({
                model:"text-embedding-ada-002",
                input:chunk,
            })
            docs.push({ pagecontent: chunk, metadata: metadata,timestamp:millisecondsSinceEpoch,embedding:embedding.data[0].embedding, docId: id });
        }
        await deleteEntriesWithID(id);
        console.log('Entry deleted for docId:',id);

        docs.forEach(async entry => {
            const {data,error}=await client
                                .from('lohumoutline')
                                .insert(entry)
            if(error)
            {
                console.error("ERROR",error);
            }
            else{
                console.log("Data inserted sucessfully for docId",id)
            }
        });
        
    }
    
    }
    catch(error){
        console.error("ERROR IN PROCESS DATA FUNCTION",error)
    }
}

async function processAllData(allData) {
    for (const batch of allData) {
        await processBatch(batch);
    }
}

const deleteEntriesNotInOutline = async (docsInOutline) => {
    // Fetch all entries where metadata->>docId is not in docsInOutline
    const docsInOutlineString = docsInOutline.map(id => `'${id}'`).join(',');
    // console.log(docsInOutlineString)
    const { data: entriesToDelete, error: fetchError } = await client
      .from('lohumoutline')
      .select('id, docId');

  
    if (fetchError) {
      console.error('Error fetching entries to delete:', fetchError);
      return;
    }

    const filteredEntries = entriesToDelete.filter(entry => !docsInOutline.includes(entry.docId));
  
    // If there are no entries to delete, return
    if (!filteredEntries.length) {
      console.log('No entries to delete.');
      return;
    }
  
    // Extract the ids of the entries to delete
    const idsToDelete = filteredEntries.map(entry => entry.id);
    console.log('IDs to be delete', idsToDelete)
    // Delete the entries
    const { error: deleteError } = await client
      .from('lohumoutline')
      .delete()
      .in('id', idsToDelete);
  
    if (deleteError) {
      console.error('Error deleting entries:', deleteError);
      return;
    }
  
    console.log(`Successfully deleted ${idsToDelete.length} entries.`);
  };
async function handleDeletedDocs(allData) {
    await deleteEntriesNotInOutline(docsInOutline);
}

exports.handler = async (event) => {
    try {
        const allData = await fetchAllData(authToken, apiEndpoint); // Extract all data from outline
        await processAllData(allData); // Process this data
        console.log('docs in outline', docsInOutline);
        await handleDeletedDocs(); // Handle docs that are no more present on outline

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Process completed successfully' }),
        };
    } catch (error) {
        console.error('Error processing data:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Internal Server Error', error: error.message }),
        };
    }
};