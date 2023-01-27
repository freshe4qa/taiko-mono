import { expect } from "chai";
import { BigNumber, ethers } from "ethers";
import { AddressManager, TaikoL1 } from "../../typechain";
import { TestTkoToken } from "../../typechain/TestTkoToken";
import { onNewL2Block } from "../utils/onNewL2Block";
import Proposer from "../utils/proposer";

import sleep from "../utils/sleep";
import { deployTaikoL1 } from "../utils/taikoL1";
import { initTokenomicsFixture } from "./utils";

describe("tokenomics: blockFee", function () {
    let taikoL1: TaikoL1;
    let l2Provider: ethers.providers.JsonRpcProvider;
    let proposerSigner: any;
    let genesisHeight: number;
    let genesisHash: string;
    let tkoTokenL1: TestTkoToken;
    let l1AddressManager: AddressManager;
    let interval: any;

    beforeEach(async () => {
        ({
            taikoL1,
            l2Provider,
            proposerSigner,
            genesisHeight,
            genesisHash,
            tkoTokenL1,
            l1AddressManager,
            interval,
        } = await initTokenomicsFixture());
    });

    afterEach(() => clearInterval(interval));

    it("expects getBlockFee to return the initial feeBase at time of contract deployment", async function () {
        // deploy a new instance of TaikoL1 so no blocks have passed.
        const tL1 = await deployTaikoL1(l1AddressManager, genesisHash, true);
        const blockFee = await tL1.getBlockFee();
        expect(blockFee).to.be.eq(0);
    });

    it("block fee should increase as the halving period passes, while no blocks are proposed", async function () {
        const { bootstrapDiscountHalvingPeriod } = await taikoL1.getConfig();

        const iterations: number = 5;
        const period: number = bootstrapDiscountHalvingPeriod
            .mul(1000)
            .toNumber();

        let lastBlockFee: BigNumber = await taikoL1.getBlockFee();

        for (let i = 0; i < iterations; i++) {
            await sleep(period);
            const blockFee = await taikoL1.getBlockFee();
            expect(blockFee.gt(lastBlockFee)).to.be.eq(true);
            lastBlockFee = blockFee;
        }
    });

    it("proposes blocks on interval, blockFee should increase, proposer's balance for TKOToken should decrease as it pays proposer fee, proofReward should increase since more slots are used and no proofs have been submitted", async function () {
        const { maxNumBlocks, commitConfirmations } = await taikoL1.getConfig();

        // set up a proposer to continually propose new blocks
        const proposer = new Proposer(
            taikoL1.connect(proposerSigner),
            l2Provider,
            commitConfirmations.toNumber(),
            maxNumBlocks.toNumber(),
            0,
            proposerSigner
        );

        // get the initiaal tkoBalance, which should decrease every block proposal
        let lastProposerTkoBalance = await tkoTokenL1.balanceOf(
            await proposerSigner.getAddress()
        );

        // do the same for the blockFee, which should increase every block proposal
        // with proofs not being submitted.
        // we want to wait for enough blocks until the blockFee is no longer 0, then run our
        // tests.
        let lastBlockFee = await taikoL1.getBlockFee();
        while (lastBlockFee.eq(0)) {
            await sleep(500);
            lastBlockFee = await taikoL1.getBlockFee();
        }

        let lastProofReward = BigNumber.from(0);

        let hasFailedAssertions: boolean = false;
        let blocksProposed: number = 0;
        // every time a l2 block is created, we should try to propose it on L1.
        l2Provider.on("block", async (blockNumber: number) => {
            if (blockNumber <= genesisHeight) return;
            try {
                const { newProposerTkoBalance, newBlockFee, newProofReward } =
                    await onNewL2Block(
                        l2Provider,
                        blockNumber,
                        proposer,
                        taikoL1,
                        proposerSigner,
                        tkoTokenL1
                    );

                expect(
                    newProposerTkoBalance.lt(lastProposerTkoBalance)
                ).to.be.eq(true);
                expect(newBlockFee.gt(lastBlockFee)).to.be.eq(true);
                expect(newProofReward.gt(lastProofReward)).to.be.eq(true);

                lastBlockFee = newBlockFee;
                lastProofReward = newProofReward;
                lastProposerTkoBalance = newProposerTkoBalance;
                blocksProposed++;
            } catch (e) {
                hasFailedAssertions = true;
                throw e;
            }
        });

        // wait until one roudn of blocks are proposed, then expect none of them to have
        // failed their assertions.
        while (blocksProposed < maxNumBlocks.toNumber() - 1) {
            await sleep(1 * 1000);
        }
        l2Provider.off("block");

        expect(hasFailedAssertions).to.be.eq(false);
    });
});
