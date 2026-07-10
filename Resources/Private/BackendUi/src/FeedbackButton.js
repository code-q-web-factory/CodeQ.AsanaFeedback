import React from 'react';
import { IconButton } from '@neos-project/react-ui-components';
import { openFeedbackWidget } from './feedback';

/**
 * Toolbar button in the Neos backend that opens the feedback widget.
 * The data attribute excludes the button itself from screenshots.
 */
export default class FeedbackButton extends React.PureComponent {
    render() {
        return (
            <div data-codeq-feedback="true" style={{ display: 'flex', alignItems: 'center' }}>
                <IconButton
                    icon="comment"
                    title="Feedback"
                    aria-label="Feedback"
                    onClick={openFeedbackWidget}
                />
            </div>
        );
    }
}
