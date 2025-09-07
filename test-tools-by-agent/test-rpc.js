const { Connection, PublicKey } = require('@solana/web3.js');

async function testRPC() {
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    const tokenAddress = new PublicKey('ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY');

    try {
        console.log('Testing Solana RPC connection...');
        
        // Test 1: Get account info
        console.log('\nTest 1: Getting account info...');
        const accountInfo = await connection.getAccountInfo(tokenAddress);
        console.log('Account exists:', accountInfo !== null);

        // Test 2: Get recent signatures
        console.log('\nTest 2: Getting recent signatures...');
        const signatures = await connection.getSignaturesForAddress(
            tokenAddress,
            { limit: 5 }
        );
        console.log('Recent signatures:', signatures.map(sig => sig.signature));

        // Test 3: Get recent transaction
        if (signatures.length > 0) {
            console.log('\nTest 3: Getting transaction details...');
            const transaction = await connection.getTransaction(signatures[0].signature);
            console.log('Transaction found:', transaction !== null);
        }

    } catch (error) {
        console.error('Error testing RPC:', error);
    }
}

testRPC();
